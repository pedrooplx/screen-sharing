/**
 * Glue between the control plane (SignalingServer / the host's own renderer)
 * and the SFU. Turns media `Body` messages into SFU calls and back.
 *
 * The same object serves remote peers (via SignalingServer) and the host's own
 * renderer (via RoomSession -> IPC): `handleMessage(peerId, body)` is symmetric,
 * the caller just passes its own peerId.
 */

import { SfuRouter, type SfuOptions } from './router.js';
import type { MediaBody } from '../../shared/ipc.js';
import type { Body, StreamInfo } from '../../shared/protocol.js';

/** The media messages a peer can send inbound. */
const INBOUND = new Set<Body['type']>([
  'publish_offer',
  'unpublish',
  'subscribe',
  'subscribe_answer',
  'unsubscribe',
]);

export function isMediaMessage(type: Body['type']): boolean {
  return INBOUND.has(type);
}

export interface MediaPlane {
  listStreams(): StreamInfo[];
  /** Handle one inbound media body; returns a body to send back, or null. */
  handleMessage(peerId: string, body: Body): Promise<MediaBody | null>;
  /** Drop everything owned by / subscribed by this peer. */
  onPeerGone(peerId: string): void;
}

export class SfuMediaPlane implements MediaPlane {
  readonly #router: SfuRouter;
  readonly #videoBitrateKbps: number;
  #broadcast: (body: MediaBody) => void = () => {};
  #sendTo: (peerId: string, body: MediaBody) => void = () => {};

  constructor(opts: SfuOptions & { videoBitrateKbps?: number } = {}) {
    this.#router = new SfuRouter(opts);
    this.#videoBitrateKbps = opts.videoBitrateKbps ?? 2500;

    this.#router.on('stream-live', (stream) =>
      this.#broadcast({ type: 'stream_state', stream, state: 'live' }),
    );
    this.#router.on('stream-ended', ({ streamId }) => {
      this.#broadcast({
        type: 'stream_state',
        stream: { streamId, ownerPeerId: '', video: false, audio: false },
        state: 'ended',
      });
    });
    // selective forwarding: tell the owner to stop/resume encoding
    this.#router.on('demand-changed', ({ streamId, ownerPeerId, subscribers }) => {
      this.#sendTo(ownerPeerId, {
        type: 'quality_directive',
        streamId,
        maxKbps: subscribers === 0 ? 0 : this.#videoBitrateKbps,
        maxFps: subscribers === 0 ? 0 : 30,
        reason: subscribers === 0 ? 'no_viewers' : 'restored',
      });
    });
  }

  /** Wired by RoomSession once the SignalingServer exists. */
  attachBroadcast(fn: (body: MediaBody) => void): void {
    this.#broadcast = fn;
  }

  /** Wired by RoomSession: deliver a targeted body to one peer (or the host). */
  attachSendTo(fn: (peerId: string, body: MediaBody) => void): void {
    this.#sendTo = fn;
  }

  listStreams(): StreamInfo[] {
    return this.#router.listStreams();
  }

  onPeerGone(peerId: string): void {
    this.#router.removePeer(peerId);
  }

  close(): void {
    this.#router.close();
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
