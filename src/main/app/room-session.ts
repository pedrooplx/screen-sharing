/**
 * One live room membership, from the main process's point of view. Wraps the
 * two roles behind one interface the IPC layer can drive:
 *
 *   - host: a SignalingServer fed by a RelayHostLink
 *   - peer: a SignalingClient over a RelayPeerLink
 *
 * This build supports exactly one room, with no password (by user request) -
 * `enter()` below is the only thing the UI calls: it tries to join, and if
 * nobody is hosting yet (`no_such_room`) becomes the host instead, with no
 * separate "create" vs "join" action and nothing to type but a nickname.
 * FIXED_ROOM_ID/FIXED_CODE_SALT/FIXED_PASSWORD are the same for every install,
 * so any two copies of this app arrive at an identical relay routing key and
 * CPace secret with no exchange at all.
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
  RelayLinkError,
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

// This app supports exactly one room, with no password. roomId is the
// relay's routing key (server/src/relay.ts keys its Map<roomId, Room> by
// this); codeSalt feeds the Argon2 salt (crypto/kdf.ts's deriveArgonSalt);
// FIXED_PASSWORD stands in for the password CPace authenticates with. All
// three are fixed, arbitrary constants - the same for every install of this
// app - rather than values a person supplies, so any two copies of the app
// arrive at an identical `w` (see crypto/kdf.ts's derivation chain) with no
// exchange whatsoever: no code, no password, nothing to type but a nickname.
//
// Security trade-off, stated plainly: CPace, Argon2id and the AES-256-GCM
// framing downstream all still run exactly as before - the wire protocol and
// every other module are completely unaware this changed - but the secret
// they're built to protect is now a public constant baked into the app
// itself. That means there is no longer any real access control on this
// room: anyone running this exact build, pointed at the same relay (the
// public shared one by default), lands in it. This only makes sense because
// there is nothing left to keep private *for* - a code and a password both
// existed to scope who could join a given room among many; with a single
// fixed room, "who can join" is answered by "who has this app and this
// relay URL" instead. Confirmed and accepted by the user (2026-09-11) -
// see docs/DESIGN.md section 6 for the full reasoning.
const FIXED_ROOM_ID = new Uint8Array([0x65, 0x72, 0x72, 0x31]);
const FIXED_CODE_SALT = new Uint8Array([0x73, 0x68, 0x61, 0x72, 0x65, 0x31]);
const FIXED_PASSWORD = 'erros-share/no-password/v1';
const FIXED_ROOM_ID_HEX = Buffer.from(FIXED_ROOM_ID).toString('hex');

export interface RoomSessionEvents {
  update: [SessionSnapshot];
  /** a media negotiation body destined for this participant's renderer */
  media: [MediaBody];
}

export interface HostOptions {
  readonly nickname: string;
  readonly roomParams?: RoomParams;
  readonly argonParams?: ArgonParams;
  /** override the relay URL (tests, or a self-hosted relay - see server/README.md) */
  readonly relayUrl?: string;
}

export interface JoinOptions {
  readonly nickname: string;
  readonly relayUrl?: string;
  /**
   * Not needed to join (peers learn the host's argonParams from hello_ack) -
   * only kept so that IF this peer is later promoted via a graceful handoff
   * (RoomSession.#promote), it derives the identical `w` the room's other
   * participants already agreed on. Production never sets this (it's always
   * the default either way); tests use it to keep MIN_ARGON_PARAMS in effect
   * across a simulated promotion.
   */
  readonly argonParams?: ArgonParams;
}

/** What the UI actually calls - see enter() below. */
export interface EnterOptions {
  readonly nickname: string;
  readonly roomParams?: RoomParams;
  readonly argonParams?: ArgonParams;
  readonly relayUrl?: string;
}

/** enter() flips between these at most this many times before giving up -
 *  covers the realistic case (two people click at nearly the same instant,
 *  one becomes host and the other's join retries once) without ever looping
 *  on a persistently broken relay. */
const MAX_ENTER_ATTEMPTS = 3;

// #rehome() gets exactly ONE handshake attempt - not several. The relay
// only ever fires PEER_UP for a survivor once per claim (relay.ts's
// #claimHandoff), which creates exactly one Connection on the new host's
// side; runHostHandshake is a strict linear state machine over it
// (hello -> hello_ack -> pake_peer -> ...). A second `hello` on that same
// connection - which is exactly what retrying looks like, since every
// attempt reuses the SAME #peerLink/connId - lands mid-handshake as an
// unexpected message and either corrupts an already-upgraded connection
// from an earlier successful-but-presumed-timed-out attempt, or gets the
// survivor's whole relay socket kicked for a protocol violation (confirmed
// by hand, the hard way). There is no safe way to retry on this connId; the
// fix is to not need to.
//
// A survivor reacts to host_transfer as soon as it arrives, which can well
// be BEFORE the successor has actually finished claiming the room - an
// earlier version of this code waited a fixed REHOME_INITIAL_DELAY_MS
// (500ms) to let that race resolve, tuned against the local test relay's
// near-zero latency. It failed against the real deployed relay: a fresh
// RelayHostLink.open() over a real WAN link (new TLS handshake, Argon2id,
// a round trip to Render) routinely takes longer than 500ms, so the
// survivor's one attempt fired early, got silently dropped by the relay's
// pending-handoff guard (relay.ts), and then just sat there until its own
// handshake timeout - confirmed live against production before this was
// understood. Fixed structurally instead of by tuning the number up:
// RelayPeerLink#onHandoffReady() fires off an explicit HOST_CLAIMED the
// relay sends the moment #claimHandoff actually runs, so #rehome() knows
// precisely when to try rather than estimating it. REHOME_MAX_WAIT_MS is
// only the give-up bound if that signal never arrives at all (nobody ever
// claims - matches the relay's own HANDOFF_GRACE_MS, plus slack for the
// teardown message to arrive).
const REHOME_MAX_WAIT_MS = 9_000;
const REHOME_HANDSHAKE_TIMEOUT_MS = 6_000;

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
  /** the peer's own relay transport, kept around (beyond #client) so a
   *  survivor of a graceful handoff can re-handshake over the SAME socket
   *  instead of needing a fresh one - see #rehome(). */
  #peerLink: RelayPeerLink | undefined;
  /** remembered purely so a later promotion/rehome reuses the same relay and
   *  Argon2 cost parameters this session originally connected with. */
  #relayUrl: string | undefined;
  #argonParams: ArgonParams | undefined;
  /** true from the moment a host_transfer is being acted on until the
   *  resulting promotion/rehome settles - guards #wireClient's close/host-lost
   *  handlers against reacting to a disconnect that IS the handoff, not a
   *  lost host. */
  #transferring = false;
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

  static async enter(opts: EnterOptions): Promise<RoomSession> {
    const session = RoomSession.begin();
    await session.enter(opts);
    return session;
  }

  /**
   * The only entry point the UI uses: no more separate "host" vs "join"
   * choice. Tries to join; if nobody is hosting yet (no_such_room), becomes
   * the host instead. Both failure modes are checked before either method
   * has created any link/client/server of its own (RelayPeerLink.open() and
   * RelayHostLink.open() are what reject with these reasons), so retrying
   * in place needs no cleanup between attempts.
   */
  async enter(opts: EnterOptions): Promise<void> {
    let asHost = false;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ENTER_ATTEMPTS; attempt++) {
      try {
        if (asHost) await this.host(opts);
        else await this.join(opts);
        return;
      } catch (err) {
        if (this.#leaving) return;
        lastErr = err;
        const reason = err instanceof RelayLinkError ? err.reason : undefined;
        if (!asHost && reason === 'no_such_room') {
          asHost = true;
        } else if (asHost && reason === 'room_exists') {
          asHost = false;
        } else {
          throw err;
        }
      }
    }
    // exhausted MAX_ENTER_ATTEMPTS still flip-flopping between the two
    // reasons - a live-lock this unlikely isn't worth retrying forever, but
    // it must still surface as a failure, not a silent no-op success.
    throw lastErr;
  }

  async host(opts: HostOptions): Promise<void> {
    this.#nickname = opts.nickname;
    this.#relayUrl = opts.relayUrl;
    this.#argonParams = opts.argonParams;
    this.#phase = 'connecting';
    this.#emit();

    const argonSalt = deriveArgonSalt(FIXED_ROOM_ID, FIXED_CODE_SALT);
    this.#w = derivePasswordKey(FIXED_PASSWORD, argonSalt, opts.argonParams);
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
    this.#relayUrl = opts.relayUrl;
    this.#argonParams = opts.argonParams;
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
    this.#peerLink = link;

    const client = new SignalingClient({
      roomId: FIXED_ROOM_ID,
      // derived lazily against the host's own argonParams (from hello_ack),
      // not assumed up front - see docs/DESIGN.md section 0, deviation 7.
      secret: { password: FIXED_PASSWORD, codeSalt: FIXED_CODE_SALT },
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
      await this.#handoffOrClose();
    } else {
      await this.#hostLink?.close().catch(() => {});
    }
    this.#media?.close();
    if (this.#w) wipe(this.#w);
    this.#w = null;
    this.#emit();
  }

  /**
   * The user clicked "Sair" while hosting (docs/DESIGN.md section 18.5): if
   * anyone else is around to take over, hand off gracefully instead of
   * ending the room for everyone. `hostLink.handoff()` tells the relay to
   * hold the room open for a successor (server/src/relay.ts); transferHost()
   * picks that successor, broadcasts it, and closes without kicking
   * survivors off their own sockets. Anything going wrong here - no
   * survivors, the relay call failing - just falls back to today's plain
   * close(), ending the room the way it always has.
   */
  async #handoffOrClose(): Promise<void> {
    const server = this.#server!;
    const hostLink = this.#hostLink;
    if (hostLink && server.roster.length > 1) {
      try {
        hostLink.handoff();
        await server.transferHost();
        return;
      } catch {
        /* fall through to a normal close below */
      }
    }
    await server.close().catch(() => {});
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
    /** a promoted successor keeps its own peerId and continues the epoch
     *  count instead of starting a brand new identity at epoch 0 */
    promotion?: { readonly epoch: number; readonly hostPeerId: string },
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
      ...(promotion
        ? { epoch: promotion.epoch, hostPeerId: promotion.hostPeerId }
        : {}),
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
      if (this.#transferring) return; // this IS the handoff, not a lost host
      this.#phase = 'left';
      this.#notice = 'Perdemos contato com o host.';
      this.#emit();
    });
    client.on('close', ({ reason }) => {
      if (this.#phase === 'left' || this.#transferring) return;
      this.#phase = 'left';
      this.#notice = `A sala encerrou: ${reason}`;
      this.#emit();
    });
    client.on('error', () => this.#emit());
    client.on('host-transfer', ({ successorPeerId, epoch }) => {
      this.#onHostTransfer(successorPeerId, epoch);
    });
  }

  /**
   * The current host named a successor before leaving (docs/DESIGN.md
   * section 18.5). Either this peer IS that successor - promote to host -
   * or it isn't - stay a peer, but re-handshake over the same relay socket
   * once the successor's own host link takes over the room.
   */
  #onHostTransfer(successorPeerId: string, epoch: number): void {
    if (this.#leaving || this.#transferring) return;
    this.#transferring = true;
    if (successorPeerId === this.#client?.peerId) {
      void this.#promote(epoch, successorPeerId);
    } else {
      void this.#rehome(epoch);
    }
  }

  /** Become the new host (docs/DESIGN.md section 18.5). */
  async #promote(epoch: number, hostPeerId: string): Promise<void> {
    this.#client?.close('promoted'); // also closes #peerLink - no longer needed
    this.#client = undefined;
    this.#peerLink = undefined;

    this.#notice = 'Assumindo como host…';
    this.#emit();

    try {
      const argonSalt = deriveArgonSalt(FIXED_ROOM_ID, FIXED_CODE_SALT);
      this.#w = derivePasswordKey(FIXED_PASSWORD, argonSalt, this.#argonParams);
      wipe(argonSalt);

      const url = resolveRelayUrl(this.#relayUrl);
      const link = await openWithRetry(() =>
        RelayHostLink.open(url, FIXED_ROOM_ID_HEX, APP_VERSION),
      );
      if (this.#leaving) {
        await link.close().catch(() => {});
        return;
      }
      this.#hostLink = link;

      await this.#startServer(FIXED_ROOM_ID, this.#roomParams, this.#argonParams, {
        epoch,
        hostPeerId,
      });
      if (this.#leaving) {
        await this.#server?.close().catch(() => {});
        return;
      }

      this.#transferring = false;
      this.#phase = 'hosting';
      this.#notice = null;
      this.#emit();
    } catch (err) {
      this.#transferring = false;
      this.#phase = 'left';
      this.#notice = `A sala encerrou: não foi possível assumir como host (${(err as Error).message}).`;
      this.#emit();
    }
  }

  /**
   * Stay a peer, but re-home to whoever just claimed the host slot - over
   * the SAME relay transport (#peerLink), never closed during a graceful
   * handoff specifically so this can happen without dialing the relay
   * again. Exactly one handshake attempt - see REHOME_MAX_WAIT_MS above for
   * why - made the instant the relay confirms someone actually claimed the
   * room (RelayPeerLink#onHandoffReady), not after a guessed delay.
   */
  async #rehome(epoch: number): Promise<void> {
    const link = this.#peerLink;
    this.#client?.detach(); // stop its heartbeat; the transport lives on
    this.#client = undefined;
    if (!link) {
      this.#roomEndedAfterFailedHandoff('conexão com o relé perdida');
      return;
    }

    this.#notice = 'Trocando de host…';
    this.#emit();
    const claimed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), REHOME_MAX_WAIT_MS);
      link.onHandoffReady(() => {
        clearTimeout(timer);
        resolve(true);
      });
      // the transport's onClose slot is free - #client.detach() only stopped
      // the heartbeat, it never claimed this (the old, now-defunct
      // Connection's registration is exactly what detach() leaves behind,
      // and nothing still needs to hear it). If the relay tears the room
      // down instead of anyone claiming it (nobody eligible, or sweep()
      // expired the grace window - relay.ts), this fires with no claim.
      link.onClose(() => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (this.#leaving) return;
    if (!claimed) {
      this.#roomEndedAfterFailedHandoff('ninguém assumiu a sala a tempo');
      return;
    }

    try {
      const client = new SignalingClient({
        roomId: FIXED_ROOM_ID,
        secret: { password: FIXED_PASSWORD, codeSalt: FIXED_CODE_SALT },
        nickname: this.#nickname,
        transport: link,
        minEpoch: epoch,
        handshakeTimeoutMs: REHOME_HANDSHAKE_TIMEOUT_MS,
      });
      this.#client = client;
      this.#wireClient(client);

      const joined = await client.connect();
      if (this.#leaving) return;
      this.#roomParams = joined.roomParams;
      this.#transferring = false;
      this.#phase = 'in-room';
      this.#notice = null;
      this.#emit();
    } catch {
      if (this.#leaving) return;
      this.#client = undefined;
      this.#roomEndedAfterFailedHandoff('o novo host não respondeu a tempo');
    }
  }

  #roomEndedAfterFailedHandoff(reason: string): void {
    this.#transferring = false;
    this.#phase = 'left';
    this.#notice = `A sala encerrou: ${reason}.`;
    this.#emit();
  }

  #emit(): void {
    this.emit('update', this.snapshot());
  }
}
