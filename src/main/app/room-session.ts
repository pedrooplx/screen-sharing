/**
 * One live room membership, from the main process's point of view. Wraps the
 * two roles behind one interface the IPC layer can drive:
 *
 *   - host: a SignalingServer fed by a RelayHostLink + the room code
 *   - peer: a SignalingClient over a RelayPeerLink
 *
 * Signaling always goes through the hosted relay (docs/DESIGN.md section 2.2 /
 * 18) - nobody opens an inbound port for the control plane any more. The relay
 * only ever forwards opaque bytes; CPace and the AES-256-GCM frames are end to
 * end between peer and host, same as before.
 *
 * Emits `update` with a full SessionSnapshot whenever anything changes, so the
 * renderer only ever consumes immutable snapshots.
 */

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import {
  type ArgonParams,
  deriveArgonSalt,
  derivePasswordKey,
  wipe,
} from '../crypto/kdf.js';
import {
  RelayHostLink,
  RelayPeerLink,
  openWithRetry,
} from '../net/relay-link.js';
import { relayUrl as resolveRelayUrl } from '../net/relay-config.js';
import { decodeRoomCode, encodeRoomCode, roomIdHex } from '../room/room-code.js';
import { primaryLanIpv4 } from '../net/local-ip.js';
import { SignalingServer } from '../signaling/server.js';
import { SignalingClient } from '../signaling/client.js';
import { SfuMediaPlane } from '../sfu/media-plane.js';
import { APP_VERSION } from '../../shared/protocol.js';
import type {
  MediaBody,
  SessionPhase,
  SessionSnapshot,
} from '../../shared/ipc.js';
import type { RoomParams, StreamInfo } from '../../shared/protocol.js';

const DEFAULT_ROOM_PARAMS: RoomParams = {
  maxParticipants: 12,
  maxRecommendedSubscriptions: 2,
  videoBitrateKbps: 2500,
};

const WAKING_NOTICE =
  'Acordando o servidor de sinalização (pode levar até 1 minuto)…';

export interface RoomSessionEvents {
  update: [SessionSnapshot];
  /** a media negotiation body destined for this participant's renderer */
  media: [MediaBody];
}

export interface HostOptions {
  readonly nickname: string;
  readonly password: string;
  readonly roomParams?: RoomParams;
  readonly argonParams?: ArgonParams;
  /** override the relay URL (tests, or a self-hosted relay - see server/README.md) */
  readonly relayUrl?: string;
}

export interface JoinOptions {
  readonly nickname: string;
  readonly password: string;
  readonly code: string;
  readonly relayUrl?: string;
}

export class RoomSession extends EventEmitter<RoomSessionEvents> {
  #phase: SessionPhase = 'idle';
  #nickname = '';
  #code: string | null = null;
  #notice: string | null = null;

  #w: Uint8Array | null = null;
  #roomParams: RoomParams = DEFAULT_ROOM_PARAMS;
  #server: SignalingServer | undefined;
  #client: SignalingClient | undefined;
  #media: SfuMediaPlane | undefined;
  #hostLink: RelayHostLink | undefined;
  /** set by leave() - lets host()/join() notice they were superseded (e.g. the
   *  user backed out, or started a new attempt) while still waiting out a slow
   *  relay cold-start, and tear down instead of leaving a link dangling. */
  #leaving = false;

  private constructor() {
    super();
  }

  // --- construction ----------------------------------------------------

  /**
   * An idle session the caller can attach `update` listeners to before calling
   * the instance `host()`/`join()` - the only way to actually observe the
   * `connecting`/`waking` phases while the relay is being dialed (see
   * `src/main/app/ipc.ts`). The static `host()`/`join()` below are `begin()` +
   * the instance method in one call, for callers (mostly tests) that only care
   * about the final result.
   */
  static begin(): RoomSession {
    return new RoomSession();
  }

  static async host(opts: HostOptions): Promise<RoomSession> {
    const session = RoomSession.begin();
    await session.host(opts);
    return session;
  }

  static async join(opts: JoinOptions): Promise<RoomSession> {
    const session = RoomSession.begin();
    await session.join(opts);
    return session;
  }

  async host(opts: HostOptions): Promise<void> {
    this.#nickname = opts.nickname;
    this.#phase = 'connecting';
    this.#emit();

    const roomId = new Uint8Array(randomBytes(4));
    const codeSalt = new Uint8Array(randomBytes(6));
    const argonSalt = deriveArgonSalt(roomId, codeSalt);
    this.#w = derivePasswordKey(opts.password, argonSalt, opts.argonParams);
    wipe(argonSalt);

    const roomParams = opts.roomParams ?? DEFAULT_ROOM_PARAMS;
    this.#roomParams = roomParams;
    this.#code = encodeRoomCode({ version: 2, roomId, codeSalt });

    const url = resolveRelayUrl(opts.relayUrl);
    const link = await openWithRetry(
      () => RelayHostLink.open(url, roomIdHex(roomId), APP_VERSION),
      { onWaking: () => this.#setWaking() },
    );
    if (this.#leaving) {
      await link.close().catch(() => {});
      return;
    }
    this.#hostLink = link;

    await this.#startServer(roomId, roomParams, opts.argonParams);
    if (this.#leaving) {
      await this.#server?.close().catch(() => {});
      return;
    }

    this.#phase = 'hosting';
    this.#notice = null;
    this.#emit();
  }

  async join(opts: JoinOptions): Promise<void> {
    this.#nickname = opts.nickname;
    this.#phase = 'connecting';
    this.#emit();

    const decoded = decodeRoomCode(opts.code);
    const url = resolveRelayUrl(opts.relayUrl);
    const link = await openWithRetry(
      () => RelayPeerLink.open(url, roomIdHex(decoded.roomId), APP_VERSION),
      { onWaking: () => this.#setWaking() },
    );
    if (this.#leaving) {
      link.close(1000, 'left before joining');
      return;
    }

    const client = new SignalingClient({
      roomId: decoded.roomId,
      // derived lazily against the host's own argonParams (from hello_ack),
      // not assumed up front - see docs/DESIGN.md section 0, deviation 7.
      secret: { password: opts.password, codeSalt: decoded.codeSalt },
      nickname: opts.nickname,
      transport: link,
    });
    this.#client = client;
    this.#wireClient(client);

    const joined = await client.connect();
    if (this.#leaving) {
      client.close('left before joining');
      return;
    }
    this.#roomParams = joined.roomParams;

    this.#phase = 'in-room';
    this.#notice = null;
    this.#emit();
  }

  #setWaking(): void {
    if (this.#phase !== 'connecting') return;
    this.#phase = 'waking';
    this.#notice = WAKING_NOTICE;
    this.#emit();
  }

  // --- lifecycle -----------------------------------------------------

  async leave(): Promise<void> {
    this.#leaving = true;
    this.#phase = 'left';
    this.#client?.close('leaving');
    if (this.#server) {
      await this.#server.close().catch(() => {});
    } else {
      await this.#hostLink?.close().catch(() => {});
    }
    this.#media?.close();
    if (this.#w) wipe(this.#w);
    this.#w = null;
    this.#emit();
  }

  snapshot(): SessionSnapshot {
    const isHost = this.#server !== undefined;
    return {
      phase: this.#phase,
      isHost,
      selfPeerId: isHost
        ? (this.#server?.hostPeerId ?? '')
        : (this.#client?.peerId ?? ''),
      nickname: this.#nickname,
      epoch: isHost ? (this.#server?.epoch ?? 0) : (this.#client?.epoch ?? 0),
      code: this.#code,
      roster: isHost ? (this.#server?.roster ?? []) : (this.#client?.roster ?? []),
      streams: this.streams,
      maxRecommendedSubscriptions: this.#roomParams.maxRecommendedSubscriptions,
      notice: this.#notice,
    };
  }

  // --- internals ----------------------------------------------------

  async #startServer(
    roomId: Uint8Array,
    roomParams: RoomParams,
    argonParams: ArgonParams | undefined,
  ): Promise<void> {
    const lanIp = primaryLanIpv4();
    const media = new SfuMediaPlane({
      videoBitrateKbps: roomParams.videoBitrateKbps,
      ...(lanIp ? { announceIp: lanIp } : {}),
    });
    this.#media = media;

    const server = new SignalingServer({
      roomId,
      w: this.#w!,
      roomParams,
      hostNickname: this.#nickname,
      source: this.#hostLink!,
      media,
      ...(argonParams ? { argonParams } : {}),
    });
    // stream_state goes to remote peers AND the host's own renderer
    media.attachBroadcast((body) => {
      server.broadcast(body);
      this.emit('media', body);
      this.#emit();
    });
    // quality_directive is targeted at one peer (or the host's own renderer)
    media.attachSendTo((peerId, body) => {
      if (peerId === server.hostPeerId) this.emit('media', body);
      else server.sendTo(peerId, body);
    });
    server.on('peer-joined', () => this.#emit());
    server.on('peer-left', () => this.#emit());
    server.on('error', () => this.#emit());
    server.on('source-closed', ({ reason }) => {
      this.#phase = 'left';
      this.#notice = `A sala encerrou: conexão com o relé perdida (${reason}).`;
      this.#emit();
    });
    await server.listen();
    this.#server = server;
  }

  // --- media (driven by the renderer through IPC) --------------------

  get streams(): StreamInfo[] {
    if (this.#media) return this.#media.listStreams();
    if (this.#client) return this.#client.streams;
    return [];
  }

  async sendMedia(body: MediaBody): Promise<void> {
    // the host: its own SFU, straight through (no signaling round-trip).
    if (this.#media && !this.#client) {
      const reply = await this.#media.handleMessage(
        this.#server?.hostPeerId ?? 'host',
        body,
      );
      if (reply) {
        this.emit('media', reply);
        this.#emit();
      }
      return;
    }
    this.#client?.send(body);
  }

  #wireClient(client: SignalingClient): void {
    client.on('roster', () => this.#emit());
    client.on('streams', () => this.#emit());
    client.on('media', (body) => this.emit('media', body));
    client.on('host-lost', () => {
      this.#phase = 'left';
      this.#notice = 'Perdemos contato com o host.';
      this.#emit();
    });
    client.on('close', ({ reason }) => {
      if (this.#phase === 'left') return; // we already initiated it
      this.#phase = 'left';
      this.#notice = `A sala encerrou: ${reason}`;
      this.#emit();
    });
    client.on('error', () => this.#emit());
  }

  #emit(): void {
    this.emit('update', this.snapshot());
  }
}
