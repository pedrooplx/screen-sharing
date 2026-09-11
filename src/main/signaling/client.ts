/**
 * The signaling client run by every peer (including the host, against its own
 * loopback server). Connects, runs the CPace handshake, joins, and keeps a
 * local mirror of the roster.
 */

import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { Connection } from '../net/connection.js';
import { WsTransport } from '../net/transport.js';
import { type ArgonParams, derivePasswordKey, deriveArgonSalt } from '../crypto/kdf.js';
import { HandshakeError, runPeerHandshake } from './handshake.js';
import { Heartbeat } from './heartbeat.js';
import type { MediaBody } from '../../shared/ipc.js';
import {
  type Body,
  type Envelope,
  type RoomParams,
  type RosterEntry,
  type StreamInfo,
  ProtocolError,
} from '../../shared/protocol.js';

const CONNECT_TIMEOUT_MS = 8_000;
const JOINED_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 2_000;
const HEARTBEAT_MAX_MISSED = 3;

export type PasswordSource =
  | { readonly w: Uint8Array }
  | { readonly password: string; readonly codeSalt: Uint8Array };

export interface SignalingClientOptions {
  readonly host: string;
  readonly port: number;
  readonly roomId: Uint8Array;
  readonly secret: PasswordSource;
  readonly nickname: string;
  readonly canHost?: boolean;
  readonly inboundPort?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatMaxMissed?: number;
  /** reject a `joined` whose epoch is below this (used when re-homing) */
  readonly minEpoch?: number;
}

export interface SignalingClientEvents {
  roster: [RosterEntry[]];
  message: [Envelope];
  /** a media negotiation body from the host (publish_answer, subscribe_offer, ...) */
  media: [MediaBody];
  /** the set of published streams changed */
  streams: [StreamInfo[]];
  /** the host stopped answering heartbeats; the owner drives failover */
  'host-lost': [];
  /** the host named a successor before leaving */
  'host-transfer': [{ successorPeerId: string; epoch: number }];
  close: [{ code: number; reason: string }];
  error: [Error];
}

export interface JoinResult {
  readonly peerId: string;
  readonly roomParams: RoomParams;
  readonly roster: RosterEntry[];
  readonly streams: StreamInfo[];
}

export class SignalingClient extends EventEmitter<SignalingClientEvents> {
  readonly #opts: SignalingClientOptions;
  #conn: Connection | undefined;
  #peerId = '';
  #roster: RosterEntry[] = [];
  #streams: StreamInfo[] = [];
  #epoch = 0;
  #heartbeat: Heartbeat | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;

  constructor(opts: SignalingClientOptions) {
    super();
    this.#opts = opts;
  }

  get peerId(): string {
    return this.#peerId;
  }

  get roster(): RosterEntry[] {
    return this.#roster;
  }

  get epoch(): number {
    return this.#epoch;
  }

  async connect(): Promise<JoinResult> {
    const url = `ws://${this.#opts.host}:${this.#opts.port}`;
    const ws = new WebSocket(url);
    // permanent handler so a late socket error is never an unhandled 'error'
    ws.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new ProtocolError('connection timed out'));
      }, CONNECT_TIMEOUT_MS);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const conn = new Connection(new WsTransport(ws), 'peer');
    this.#conn = conn;

    await runPeerHandshake(conn, {
      roomId: this.#opts.roomId,
      deriveW: (params) => this.#deriveW(params),
    });
    conn.outboundFrom = 'pending';

    conn.send({
      type: 'join',
      nickname: this.#opts.nickname,
      clientCaps: {
        canHost: this.#opts.canHost ?? false,
        inboundPort: this.#opts.inboundPort ?? 0,
      },
    });

    const joined = await this.#waitForJoined(conn);
    if (joined.epoch < (this.#opts.minEpoch ?? 0)) {
      conn.close(1000, 'stale epoch');
      throw new HandshakeError(
        `host epoch ${joined.epoch} is older than expected ${this.#opts.minEpoch}`,
        'bad_message',
      );
    }
    this.#peerId = joined.peerId;
    this.#roster = joined.roster;
    this.#epoch = joined.epoch;
    conn.outboundFrom = joined.peerId;

    conn.on('message', (env) => this.#onMessage(env));
    conn.on('close', (info) => {
      this.#stopHeartbeat();
      this.emit('close', info);
    });
    conn.on('error', (err) => this.emit('error', err));

    this.#streams = joined.streams;
    this.#startHeartbeat(conn);
    this.emit('roster', this.#roster);
    this.emit('streams', this.#streams);
    return {
      peerId: joined.peerId,
      roomParams: joined.roomParams,
      roster: joined.roster,
      streams: joined.streams,
    };
  }

  get streams(): StreamInfo[] {
    return this.#streams;
  }

  send(body: Body): void {
    if (!this.#conn) throw new ProtocolError('not connected');
    this.#conn.send(body);
  }

  /** Send a one-off ping (the heartbeat sends its own automatically). */
  ping(): void {
    this.send({
      type: 'ping',
      nonce: Math.floor(Math.random() * 1e9),
      sentAt: Date.now(),
    });
  }

  close(reason = 'user left'): void {
    this.#stopHeartbeat();
    if (!this.#conn) return;
    try {
      this.#conn.send({ type: 'bye', reason });
    } catch {
      /* ignore */
    }
    this.#conn.close(1000, 'bye');
  }

  #startHeartbeat(conn: Connection): void {
    const interval = this.#opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.#heartbeat = new Heartbeat({
      maxMissed: this.#opts.heartbeatMaxMissed ?? HEARTBEAT_MAX_MISSED,
      sendPing: (nonce, sentAt) => {
        try {
          conn.send({ type: 'ping', nonce, sentAt });
        } catch {
          /* connection error handler will surface it */
        }
      },
      onDead: () => {
        this.#stopHeartbeat();
        this.emit('host-lost');
      },
    });
    this.#heartbeat.start();
    this.#heartbeatTimer = setInterval(() => this.#heartbeat?.tick(), interval);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    this.#heartbeat?.stop();
  }

  async #deriveW(params: ArgonParams): Promise<Uint8Array> {
    if ('w' in this.#opts.secret) return this.#opts.secret.w;
    const salt = deriveArgonSalt(this.#opts.roomId, this.#opts.secret.codeSalt);
    return derivePasswordKey(this.#opts.secret.password, salt, params);
  }

  #waitForJoined(conn: Connection): Promise<Extract<Body, { type: 'joined' }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new ProtocolError('timed out waiting for joined'));
      }, JOINED_TIMEOUT_MS);
      const onMessage = (env: Envelope) => {
        if (env.body.type === 'joined') {
          cleanup();
          resolve(env.body);
        } else if (env.body.type === 'rejected') {
          cleanup();
          reject(new HandshakeError(`join rejected: ${env.body.reason}`, 'bad_message'));
        } else if (env.body.type === 'bye') {
          cleanup();
          reject(new HandshakeError(`host said bye: ${env.body.reason}`, 'closed'));
        }
      };
      const onClose = () => {
        cleanup();
        reject(new ProtocolError('connection closed before joined'));
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

  #onMessage(env: Envelope): void {
    switch (env.body.type) {
      case 'roster_update': {
        const removed = new Set(env.body.removed);
        const changed = new Map(env.body.changed.map((e) => [e.peerId, e]));
        this.#roster = this.#roster
          .filter((e) => !removed.has(e.peerId))
          .map((e) => changed.get(e.peerId) ?? e)
          .concat(env.body.added);
        this.#roster.sort((a, b) => a.joinSeq - b.joinSeq);
        this.emit('roster', this.#roster);
        break;
      }
      case 'ping':
        this.send({ type: 'pong', nonce: env.body.nonce, sentAt: env.body.sentAt });
        break;
      case 'pong':
        this.#heartbeat?.onPong(env.body.nonce);
        break;
      case 'host_transfer':
        this.emit('host-transfer', {
          successorPeerId: env.body.successorPeerId,
          epoch: env.body.epoch,
        });
        break;
      case 'bye':
        this.#stopHeartbeat();
        this.emit('close', { code: 1000, reason: env.body.reason });
        break;
      case 'stream_state': {
        const { stream, state } = env.body;
        this.#streams =
          state === 'ended'
            ? this.#streams.filter((s) => s.streamId !== stream.streamId)
            : [
                ...this.#streams.filter((s) => s.streamId !== stream.streamId),
                stream,
              ];
        this.emit('streams', this.#streams);
        break;
      }
      case 'publish_answer':
      case 'subscribe_offer':
      case 'media_error':
      case 'quality_directive':
        this.emit('media', env.body);
        break;
      default:
        this.emit('message', env);
    }
  }
}
