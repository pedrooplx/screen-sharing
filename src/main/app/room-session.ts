/**
 * One live room membership, from the main process's point of view. Wraps the
 * two roles behind one interface the IPC layer can drive:
 *
 *   - host: a SignalingServer fed by a RelayHostLink
 *   - peer: a SignalingClient over a RelayPeerLink
 *
 * This build supports exactly one room (by user request) - there is no room
 * code to generate, share, or type in. FIXED_ROOM_ID/FIXED_CODE_SALT below are
 * the same for every host and every joiner, so the two sides arrive at an
 * identical relay routing key and Argon2 salt with no exchange at all; the
 * only thing that still has to match between host and peer is the password.
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
import { primaryLanIpv4 } from '../net/local-ip.js';
import { defaultIceServers } from '../net/stun.js';
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
  // Calibrated to the governor's top rung, 1080p60 (src/main/sfu/governor.ts)
  // - the ladder's other rungs are fractions of this. 12 participants at
  // 6 Mbps/stream changes docs/DESIGN.md §11's egress math meaningfully
  // (roughly 2.3x the old 2500kbps baseline); the 20 Mbps default egress
  // budget in SfuMediaPlane's governor still applies, so it'll just step
  // subscriptions down the ladder sooner under load than before.
  videoBitrateKbps: 6000,
};

const WAKING_NOTICE =
  'Acordando o servidor de sinalização (pode levar até 1 minuto)…';

// This app supports exactly one room. roomId is the relay's routing key
// (server/src/relay.ts keys its Map<roomId, Room> by this), and codeSalt
// domain-separates the Argon2 salt (crypto/kdf.ts's deriveArgonSalt) so the
// same password doesn't hash to the same key across DIFFERENT rooms - a
// concern that no longer applies by construction, since there's only ever
// one. Both are fixed, arbitrary constants rather than random per-session
// values so a joining peer can arrive at them with no exchange whatsoever;
// the only thing that still needs to match between host and peer is the
// password itself.
//
// Trade-off worth stating plainly: every installation of this exact app
// build now shares the same Argon2 salt, so a rainbow table computed against
// it would work against any of them - previously each hosting session got a
// fresh random salt. Argon2id is still deliberately slow/memory-hard and the
// password is still the only real secret, so this is an acceptable trade for
// a small private-group tool, not a public multi-tenant service.
const FIXED_ROOM_ID = new Uint8Array([0x65, 0x72, 0x72, 0x31]);
const FIXED_CODE_SALT = new Uint8Array([0x73, 0x68, 0x61, 0x72, 0x65, 0x31]);
const FIXED_ROOM_ID_HEX = Buffer.from(FIXED_ROOM_ID).toString('hex');

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
  readonly relayUrl?: string;
}

export class RoomSession extends EventEmitter<RoomSessionEvents> {
  #phase: SessionPhase = 'idle';
  #nickname = '';
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

    const argonSalt = deriveArgonSalt(FIXED_ROOM_ID, FIXED_CODE_SALT);
    this.#w = derivePasswordKey(opts.password, argonSalt, opts.argonParams);
    wipe(argonSalt);

    const roomParams = opts.roomParams ?? DEFAULT_ROOM_PARAMS;
    this.#roomParams = roomParams;

    const url = resolveRelayUrl(opts.relayUrl);
    const link = await openWithRetry(
      () => RelayHostLink.open(url, FIXED_ROOM_ID_HEX, APP_VERSION),
      { onWaking: () => this.#setWaking() },
    );
    if (this.#leaving) {
      await link.close().catch(() => {});
      return;
    }
    this.#hostLink = link;

    await this.#startServer(FIXED_ROOM_ID, roomParams, opts.argonParams);
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

    const url = resolveRelayUrl(opts.relayUrl);
    const link = await openWithRetry(
      () => RelayPeerLink.open(url, FIXED_ROOM_ID_HEX, APP_VERSION),
      { onWaking: () => this.#setWaking() },
    );
    if (this.#leaving) {
      link.close(1000, 'left before joining');
      return;
    }

    const client = new SignalingClient({
      roomId: FIXED_ROOM_ID,
      // derived lazily against the host's own argonParams (from hello_ack),
      // not assumed up front - see docs/DESIGN.md section 0, deviation 7.
      secret: { password: opts.password, codeSalt: FIXED_CODE_SALT },
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
      // public STUN by default (docs/DESIGN.md 8.3/18.6): this is what lets
      // the SFU discover its own reflexive address with one outbound UDP
      // packet, so media hole-punches without an inbound port on the host -
      // the same property the relay pivot already gave the control plane.
      iceServers: defaultIceServers(),
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
