/**
 * Glue between the control plane (SignalingServer / the host's own renderer)
 * and the SFU. Turns media `Body` messages into SFU calls and back, and runs
 * the bandwidth/CPU governor (docs/DESIGN.md section 8.5).
 *
 * `handleMessage(peerId, body)` is symmetric: it serves remote peers (via
 * SignalingServer) and the host's own renderer (via RoomSession -> IPC), the
 * caller just passes its own peerId.
 */

import { SfuRouter, type SfuOptions } from './router.js';
import { Governor } from './governor.js';
import type { MediaBody } from '../../shared/ipc.js';
import type { Body, StreamInfo } from '../../shared/protocol.js';

/** The media messages a peer can send inbound. */
const INBOUND = new Set<Body['type']>([
  'publish_offer',
  'unpublish',
  'subscribe',
  'subscribe_answer',
  'unsubscribe',
  'stats_report',
]);

export function isMediaMessage(type: Body['type']): boolean {
  return INBOUND.has(type);
}

export interface MediaPlane {
  listStreams(): StreamInfo[];
  handleMessage(peerId: string, body: Body): Promise<MediaBody | null>;
  onPeerGone(peerId: string): void;
}

const EVALUATE_INTERVAL_MS = 5_000;

export class SfuMediaPlane implements MediaPlane {
  readonly #router: SfuRouter;
  readonly #governor: Governor;
  readonly #videoBitrateKbps: number;
  #broadcast: (body: MediaBody) => void = () => {};
  #sendTo: (peerId: string, body: MediaBody) => void = () => {};
  #timer: NodeJS.Timeout | undefined;

  constructor(opts: SfuOptions & { videoBitrateKbps?: number } = {}) {
    this.#router = new SfuRouter(opts);
    this.#videoBitrateKbps = opts.videoBitrateKbps ?? 2500;
    this.#governor = new Governor({ baseKbps: this.#videoBitrateKbps });

    this.#router.on('stream-live', (stream) => {
      this.#governor.register(stream.streamId, stream.ownerPeerId);
      this.#broadcast({ type: 'stream_state', stream, state: 'live' });
    });
    this.#router.on('stream-ended', ({ streamId }) => {
      this.#governor.forget(streamId);
      this.#broadcast({
        type: 'stream_state',
        stream: { streamId, ownerPeerId: '', video: false, audio: false },
        state: 'ended',
      });
    });
    this.#router.on('demand-changed', ({ streamId, ownerPeerId, subscribers }) => {
      if (subscribers === 0) {
        this.#governor.setPaused(streamId, true);
        this.#sendTo(ownerPeerId, {
          type: 'quality_directive',
          streamId,
          maxKbps: 0,
          maxFps: 0,
          scaleDownBy: 1,
          reason: 'no_viewers',
        });
      } else {
        this.#governor.setPaused(streamId, false);
        const resume = this.#governor.resumeDirective(streamId);
        if (resume) {
          this.#sendTo(ownerPeerId, { type: 'quality_directive', ...toWire(resume) });
        }
      }
    });

    this.#timer = setInterval(() => this.#runGovernor(), EVALUATE_INTERVAL_MS);
  }

  attachBroadcast(fn: (body: MediaBody) => void): void {
    this.#broadcast = fn;
  }

  attachSendTo(fn: (peerId: string, body: MediaBody) => void): void {
    this.#sendTo = fn;
  }

  listStreams(): StreamInfo[] {
    return this.#router.listStreams();
  }

  onPeerGone(peerId: string): void {
    this.#governor.dropSubscriber(peerId);
    this.#router.removePeer(peerId);
  }

  close(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#router.close();
  }

  #runGovernor(): void {
    for (const d of this.#governor.evaluate()) {
      this.#sendTo(d.ownerPeerId, { type: 'quality_directive', ...toWire(d) });
    }
  }

  async handleMessage(peerId: string, body: Body): Promise<MediaBody | null> {
    try {
      switch (body.type) {
        case 'publish_offer': {
          const { answerSdp } = await this.#router.publish(
            peerId,
            body.streamId,
            body.sdp,
            { video: body.video, audio: body.audio },
          );
          return { type: 'publish_answer', streamId: body.streamId, sdp: answerSdp };
        }
        case 'unpublish':
          this.#router.unpublish(body.streamId);
          return null;
        case 'subscribe': {
          const { offerSdp } = await this.#router.subscribe(peerId, body.streamId);
          return { type: 'subscribe_offer', streamId: body.streamId, sdp: offerSdp };
        }
        case 'subscribe_answer':
          await this.#router.completeSubscribe(peerId, body.streamId, body.sdp);
          return null;
        case 'unsubscribe':
          this.#router.unsubscribe(peerId, body.streamId);
          return null;
        case 'stats_report': {
          for (const sub of body.subscriptions) {
            this.#governor.ingestSubscriber({
              streamId: sub.streamId,
              subscriberPeerId: peerId,
              fractionLost: sub.fractionLost,
              rttMs: sub.rttMs,
              fps: sub.fps,
            });
          }
          for (const pub of body.publications) {
            this.#governor.ingestPublisher({
              streamId: pub.streamId,
              cpuPressure: pub.cpuPressure,
              fps: pub.fps,
            });
          }
          return null;
        }
        default:
          return null;
      }
    } catch (err) {
      const streamId =
        'streamId' in body && typeof body.streamId === 'string'
          ? body.streamId
          : '';
      return {
        type: 'media_error',
        streamId,
        reason: (err as Error).message.slice(0, 160),
      };
    }
  }
}

function toWire(d: {
  streamId: string;
  maxKbps: number;
  maxFps: number;
  scaleDownBy: number;
  reason: 'bandwidth' | 'cpu' | 'restored';
}): Omit<Extract<MediaBody, { type: 'quality_directive' }>, 'type'> {
  return {
    streamId: d.streamId,
    maxKbps: d.maxKbps,
    maxFps: d.maxFps,
    scaleDownBy: d.scaleDownBy,
    reason: d.reason,
  };
}
