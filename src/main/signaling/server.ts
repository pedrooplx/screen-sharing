/**
 * The signaling server embedded in the host process. One WebSocketServer bound
 * to the mapped TCP port; every connection runs the CPace handshake, then joins
 * the roster. Heartbeat detects a peer that stopped responding; an optional
 * reachability probe sets `inboundVerified` for the succession order.
 *
 * Media negotiation and failover build on the same connection objects.
 */

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Connection } from '../net/connection.js';
import type { ConnectionSource, Transport } from '../net/transport.js';
import { WsConnectionSource } from '../net/ws-source.js';
import { tcpReachable } from '../net/reachability.js';
import {
  type ArgonParams,
  DEFAULT_ARGON_PARAMS,
} from '../crypto/kdf.js';
import { runHostHandshake, HandshakeError } from './handshake.js';
import { Heartbeat } from './heartbeat.js';
import { Roster } from './roster.js';
import {
  electionEntriesFromRoster,
  successionOrder,
} from '../election/succession.js';
import {
  DEFAULT_RATE_LIMIT,
  RateLimiter,
  type RateLimitConfig,
} from './rate-limit.js';
import { type MediaPlane, isMediaMessage } from '../sfu/media-plane.js';
import {
  type Body,
  type Envelope,
  type RoomParams,
  type RosterEntry,
  ProtocolError,
} from '../../shared/protocol.js';

const MAX_CONCURRENT_HANDSHAKES = 3;
const JOIN_TIMEOUT_MS = 8_000;
const HEARTBEAT_INTERVAL_MS = 2_000;
const HEARTBEAT_MAX_MISSED = 3;

export interface SignalingServerOptions {
  readonly roomId: Uint8Array;
  /** password-derived key `w`, precomputed once */
  readonly w: Uint8Array;
  readonly roomParams: RoomParams;
  readonly hostNickname: string;
  /** where inbound Connections come from. Default: a local WebSocketServer on
   *  `bindAddress:port` (tests only). Production passes a RelayHostLink. */
  readonly source?: ConnectionSource;
  readonly bindAddress?: string;
  readonly port?: number;
  readonly argonParams?: ArgonParams;
  readonly rateLimit?: RateLimitConfig;
  /** heartbeat interval in ms (default 2000; lower it in tests) */
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatMaxMissed?: number;
  /** probe each peer's claimed inbound port to set `inboundVerified` */
  readonly verifyInbound?: boolean;
  /** host generation; a promoted heir starts at previous epoch + 1 */
  readonly epoch?: number;
  /** peerId to advertise as the host (a promoted heir keeps its existing id) */
  readonly hostPeerId?: string;
  /** the SFU; when present, media messages are routed to it */
  readonly media?: MediaPlane;
}

export interface SignalingServerEvents {
  'peer-joined': [{ peerId: string; nickname: string }];
  'peer-left': [{ peerId: string; nickname: string; reason: 'bye' | 'timeout' }];
  'peer-rejected': [{ ip: string; reason: string }];
  /** the connection source itself is gone (relay link dropped, local wss
   *  failed) - unlike `error`, this means the room cannot continue */
  'source-closed': [{ reason: string }];
  error: [Error];
}

interface PeerLink {
  readonly peerId: string;
  readonly conn: Connection;
  readonly ip: string;
  heartbeat: Heartbeat | undefined;
  heartbeatTimer: NodeJS.Timeout | undefined;
  reason: 'bye' | 'timeout';
}

export class SignalingServer extends EventEmitter<SignalingServerEvents> {
  readonly #opts: SignalingServerOptions;
  readonly #rateLimiter: RateLimiter;
  readonly #roster: Roster;
  readonly #hostPeerId: string;
  readonly #links = new Map<string, PeerLink>();
  #source: ConnectionSource | undefined;
  #ownsSource = false;
  #activeHandshakes = 0;
  #closing = false;

  readonly #epoch: number;

  constructor(opts: SignalingServerOptions) {
    super();
    this.#opts = opts;
    this.#rateLimiter = new RateLimiter(opts.rateLimit ?? DEFAULT_RATE_LIMIT);
    this.#epoch = opts.epoch ?? 0;
    this.#hostPeerId = opts.hostPeerId ?? `p_${randomBytes(4).toString('hex')}`;
    this.#roster = new Roster({
      peerId: this.#hostPeerId,
      nickname: opts.hostNickname,
      isHost: true,
      inboundVerified: true,
      inboundEndpoint: null,
      publishing: null,
    });
  }

  get epoch(): number {
    return this.#epoch;
  }

  get hostPeerId(): string {
    return this.#hostPeerId;
  }

  get roster(): RosterEntry[] {
    return this.#roster.snapshot();
  }

  /** Start accepting connections. Returns the bound port for the local
   *  WebSocketServer path, or -1 when running over an injected source. */
  async listen(): Promise<{ port: number }> {
    let boundPort = -1;
    if (this.#opts.source) {
      this.#source = this.#opts.source;
    } else {
      const ws = new WsConnectionSource();
      const { port } = await ws.listen(
        this.#opts.bindAddress ?? '127.0.0.1',
        this.#opts.port ?? 0,
      );
      boundPort = port;
      this.#source = ws;
      this.#ownsSource = true;
    }
    this.#source.onConnection((transport, ip) => {
      void this.#handleConnection(transport, ip);
    });
    this.#source.onClosed((reason) => {
      if (!this.#closing) this.emit('source-closed', { reason });
    });
    return { port: boundPort };
  }

  /** Was this server started over an injected (relay) source? */
  get overRelay(): boolean {
    return this.#opts.source !== undefined;
  }

  /**
   * Graceful handoff (docs/DESIGN.md section 9.2 / 18.5): name the best
   * successor, tell everyone, give them a moment to act, then close.
   * Near-zero interruption vs. waiting for a heartbeat timeout.
   */
  async transferHost(graceMs = 1_500): Promise<void> {
    const order = successionOrder(
      electionEntriesFromRoster(this.#roster.snapshot()),
    );
    const successor = order[0];
    if (!successor) {
      await this.close();
      return;
    }
    // Mark closing NOW, not only once #closeForHandoff() runs after the
    // grace wait below: every survivor was just told to move on, so this
    // host must not send any of them anything else in the meantime. It
    // still can (and does, right below) - #closing only gates #onPeerGone's
    // roster_update and #handleConnection's rejection of brand-new joins,
    // never broadcast()/sendTo() directly. Without this, a heartbeat ping
    // or a roster_update from a survivor disconnecting mid-window (the
    // promoted successor detaches almost immediately) lands as a stray
    // encrypted frame on a survivor's shared relay transport while its
    // fresh post-handoff Connection is mid-handshake; Connection#upgrade
    // queues an early binary frame assuming it's meant for the new
    // session's keys, and fails to decrypt it because it was actually
    // encrypted under this (dying) session's keys instead - confirmed the
    // hard way, live.
    this.#closing = true;
    this.broadcast({
      type: 'host_transfer',
      successorPeerId: successor,
      epoch: this.#epoch + 1,
    });
    for (const link of this.#links.values()) {
      if (link.heartbeatTimer) clearInterval(link.heartbeatTimer);
      link.heartbeat?.stop();
    }
    await new Promise((r) => setTimeout(r, graceMs));
    await this.#closeForHandoff();
  }

  /**
   * Close this server's own connection source without touching individual
   * peer links - unlike close()/crash(), this never sends `bye` or calls
   * conn.close() per peer. Over the relay, conn.close() on a peer's
   * Connection maps to a KICK, which severs that peer's socket at the relay
   * for good - exactly what transferHost() must not do, since a surviving
   * peer needs that same socket to re-handshake with whoever claims the
   * room next (RoomSession pairs this with RelayHostLink.handoff() so the
   * relay holds the room open instead of tearing it down the moment this
   * source closes - see server/src/relay.ts).
   */
  async #closeForHandoff(): Promise<void> {
    this.#closing = true;
    for (const link of this.#links.values()) {
      if (link.heartbeatTimer) clearInterval(link.heartbeatTimer);
      link.heartbeat?.stop();
    }
    this.#links.clear();
    if (this.#source) {
      await this.#source.close();
      this.#source = undefined;
    }
  }

  /** Send one body to one connected peer. No-op if that peer is gone. */
  sendTo(peerId: string, body: Body): void {
    const link = this.#links.get(peerId);
    if (!link) return;
    try {
      link.conn.send(body);
    } catch {
      /* the connection's own error handler will clean it up */
    }
  }

  broadcast(body: Body, exceptPeerId?: string): void {
    for (const link of this.#links.values()) {
      if (link.peerId === exceptPeerId) continue;
      try {
        link.conn.send(body);
      } catch {
        /* the connection's own error handler will clean it up */
      }
    }
  }

  /**
   * Abrupt shutdown with no `bye` and no graceful handoff - simulates the host
   * process being killed. Peers discover it via the dropped socket / heartbeat.
   */
  crash(): void {
    this.#closing = true;
    for (const link of this.#links.values()) {
      if (link.heartbeatTimer) clearInterval(link.heartbeatTimer);
      link.heartbeat?.stop();
      link.conn.close(4001, 'crash');
    }
    this.#links.clear();
    if (this.#ownsSource && this.#source instanceof WsConnectionSource) {
      this.#source.terminate();
    } else {
      void this.#source?.close();
    }
    this.#source = undefined;
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const link of this.#links.values()) {
      try {
        link.conn.send({ type: 'bye', reason: 'room_closing' });
      } catch {
        /* ignore */
      }
      if (link.heartbeatTimer) clearInterval(link.heartbeatTimer);
      link.heartbeat?.stop();
      link.conn.close(1001, 'room closing');
    }
    this.#links.clear();
    if (this.#source) {
      await this.#source.close();
      this.#source = undefined;
    }
  }

  async #handleConnection(transport: Transport, ip: string): Promise<void> {
    const conn = new Connection(transport, 'host');
    conn.outboundFrom = this.#hostPeerId;
    conn.epoch = this.#epoch;

    if (this.#closing) {
      conn.sendHandshake({ type: 'handshake_reject', reason: 'room_closing' });
      conn.close(1001, 'room closing');
      return;
    }

    const wait = this.#rateLimiter.take(ip);
    if (wait !== null) {
      conn.sendHandshake({ type: 'handshake_reject', reason: 'rate_limited' });
      conn.close(1008, 'rate limited');
      this.emit('peer-rejected', { ip, reason: 'rate_limited' });
      return;
    }

    if (this.#activeHandshakes >= MAX_CONCURRENT_HANDSHAKES) {
      conn.sendHandshake({ type: 'handshake_reject', reason: 'too_many_handshakes' });
      conn.close(1013, 'busy');
      this.emit('peer-rejected', { ip, reason: 'too_many_handshakes' });
      return;
    }

    this.#activeHandshakes++;
    try {
      await runHostHandshake(conn, {
        roomId: this.#opts.roomId,
        w: this.#opts.w,
        argonParams: this.#opts.argonParams ?? DEFAULT_ARGON_PARAMS,
      });
    } catch (err) {
      const reason = err instanceof HandshakeError ? err.reason : 'error';
      this.emit('peer-rejected', { ip, reason });
      conn.close(1002, 'handshake failed');
      return;
    } finally {
      this.#activeHandshakes--;
    }

    // A completed handshake proves the password: reset this IP's rate standing.
    this.#rateLimiter.clear(ip);

    try {
      await this.#admit(conn, ip);
    } catch (err) {
      this.emit('error', err as Error);
      conn.close(1002, 'admission failed');
    }
  }

  async #admit(conn: Connection, ip: string): Promise<void> {
    const join = await waitForBody(conn, 'join', JOIN_TIMEOUT_MS);

    if (this.#roster.size() >= this.#opts.roomParams.maxParticipants) {
      conn.send({ type: 'rejected', reason: 'room_full' });
      conn.close(1000, 'room full');
      this.emit('peer-rejected', { ip, reason: 'room_full' });
      return;
    }
    if (this.#roster.hasNickname(join.nickname)) {
      conn.send({ type: 'rejected', reason: 'duplicate_nickname' });
      conn.close(1000, 'duplicate nickname');
      this.emit('peer-rejected', { ip, reason: 'duplicate_nickname' });
      return;
    }

    const peerId = `p_${randomBytes(4).toString('hex')}`;
    const entry: RosterEntry = {
      peerId,
      nickname: join.nickname,
      joinSeq: this.#roster.allocateJoinSeq(),
      isHost: false,
      inboundVerified: false,
      inboundEndpoint: null,
      publishing: null,
    };
    this.#roster.add(entry);
    const link: PeerLink = {
      peerId,
      conn,
      ip,
      heartbeat: undefined,
      heartbeatTimer: undefined,
      reason: 'bye',
    };
    this.#links.set(peerId, link);

    conn.on('message', (env) => this.#onPeerMessage(peerId, env));
    conn.on('close', () => this.#onPeerGone(peerId));

    conn.send({
      type: 'joined',
      peerId,
      joinSeq: entry.joinSeq,
      epoch: this.#epoch,
      roomParams: this.#opts.roomParams,
      roster: this.#roster.snapshot(),
      streams: this.#opts.media?.listStreams() ?? [],
    });
    this.broadcast({ type: 'roster_update', added: [entry], removed: [], changed: [] }, peerId);
    this.emit('peer-joined', { peerId, nickname: entry.nickname });

    this.#startHeartbeat(link);

    if (this.#opts.verifyInbound && join.clientCaps.inboundPort > 0) {
      void this.#probeInbound(peerId, ip, join.clientCaps.inboundPort);
    }
  }

  #startHeartbeat(link: PeerLink): void {
    const interval = this.#opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    link.heartbeat = new Heartbeat({
      maxMissed: this.#opts.heartbeatMaxMissed ?? HEARTBEAT_MAX_MISSED,
      sendPing: (nonce, sentAt) => {
        try {
          link.conn.send({ type: 'ping', nonce, sentAt });
        } catch {
          /* connection error handler will clean up */
        }
      },
      onDead: () => {
        link.reason = 'timeout';
        link.conn.close(4000, 'heartbeat timeout');
      },
    });
    link.heartbeat.start();
    link.heartbeatTimer = setInterval(() => link.heartbeat?.tick(), interval);
  }

  async #probeInbound(peerId: string, ip: string, port: number): Promise<void> {
    const result = await tcpReachable(ip, port);
    const link = this.#links.get(peerId);
    if (!link) return;
    const updated = this.#roster.update(peerId, {
      inboundVerified: result.reachable,
      inboundEndpoint: result.reachable ? { address: ip, port } : null,
    });
    if (updated) {
      this.broadcast({
        type: 'roster_update',
        added: [],
        removed: [],
        changed: [updated],
      });
    }
  }

  #onPeerMessage(peerId: string, env: Envelope): void {
    const link = this.#links.get(peerId);
    if (!link) return;
    switch (env.body.type) {
      case 'ping':
        link.conn.send({
          type: 'pong',
          nonce: env.body.nonce,
          sentAt: env.body.sentAt,
        });
        break;
      case 'pong':
        link.heartbeat?.onPong(env.body.nonce);
        break;
      case 'bye':
        link.reason = 'bye';
        link.conn.close(1000, 'bye');
        break;
      default:
        if (isMediaMessage(env.body.type) && this.#opts.media) {
          void this.#handleMedia(peerId, env.body);
          break;
        }
        // join is only valid once; anything else here is unexpected for now
        this.emit(
          'error',
          new ProtocolError(`unexpected ${env.body.type} from ${peerId}`),
        );
    }
  }

  async #handleMedia(peerId: string, body: Body): Promise<void> {
    const reply = await this.#opts.media!.handleMessage(peerId, body);
    const link = this.#links.get(peerId);
    if (reply && link) link.conn.send(reply);
  }

  #onPeerGone(peerId: string): void {
    // Already closing (transferHost()'s handoff window, or close()/crash()):
    // don't broadcast a roster_update to the remaining links. A survivor
    // reacting to a graceful handoff may already be mid-handshake on a
    // brand new Connection over its (shared, reused) relay transport - an
    // unrelated encrypted frame landing there right now would be queued as
    // an "arrived early" envelope and fail to decrypt once that new
    // handshake's own keys are installed (see transferHost() for the full
    // story). Nothing needs this host's roster/#links bookkeeping to stay
    // current in that window either - it's being torn down regardless.
    if (this.#closing) return;
    const link = this.#links.get(peerId);
    if (link?.heartbeatTimer) clearInterval(link.heartbeatTimer);
    link?.heartbeat?.stop();
    this.#opts.media?.onPeerGone(peerId);
    const removed = this.#roster.remove(peerId);
    this.#links.delete(peerId);
    if (!removed) return;
    this.broadcast({
      type: 'roster_update',
      added: [],
      removed: [peerId],
      changed: [],
    });
    this.emit('peer-left', {
      peerId,
      nickname: removed.nickname,
      reason: link?.reason ?? 'bye',
    });
  }
}

/** Wait for the next encrypted envelope whose body has the given type. */
function waitForBody<T extends Body['type']>(
  conn: Connection,
  type: T,
  timeoutMs: number,
): Promise<Extract<Body, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new ProtocolError(`timed out waiting for ${type}`));
    }, timeoutMs);
    const onMessage = (env: Envelope) => {
      if (env.body.type !== type) {
        cleanup();
        reject(new ProtocolError(`expected ${type}, got ${env.body.type}`));
        return;
      }
      cleanup();
      resolve(env.body as Extract<Body, { type: T }>);
    };
    const onClose = () => {
      cleanup();
      reject(new ProtocolError('connection closed before message'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      conn.off('message', onMessage);
      conn.off('close', onClose);
    };
    conn.on('message', onMessage);
    conn.on('close', onClose);
  });
}
