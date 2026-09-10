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
  #broadcast: (body: MediaBody) => void = () => {};

  constructor(opts: SfuOptions = {}) {
    this.#router = new SfuRouter(opts);
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
  }

  /** Wired by RoomSession once the SignalingServer exists. */
  attachBroadcast(fn: (body: MediaBody) => void): void {
    this.#broadcast = fn;
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
