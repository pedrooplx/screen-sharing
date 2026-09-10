/**
 * A full participant. Wraps, for one person in the room:
 *
 *   - a SignalingClient to the current host
 *   - an always-on HeirProbeResponder on the peer's inbound UDP port
 *   - a bare TCP listener on the same port number so the host's reachability
 *     probe succeeds (and, on promotion, the real SignalingServer takes it over)
 *   - a Failover coordinator that reacts to `host-lost` / `host-transfer`
 *
 * On promotion this peer starts its own SignalingServer (epoch + 1) and re-homes
 * its own client to it; other peers re-home to it via `connect-heir`.
 */

import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:net';
import { HeirProbeResponder, heirProbe } from '../net/heir-probe.js';
import { Failover, type FailoverAction } from '../election/failover.js';
import { SignalingClient } from './client.js';
import { SignalingServer } from './server.js';
import { encodeRoomCode } from '../room/room-code.js';
import type { MediaBody } from '../../shared/ipc.js';
import type { RoomParams, RosterEntry, StreamInfo } from '../../shared/protocol.js';

export interface PeerNodeOptions {
  readonly host: string;
  readonly port: number;
  readonly roomId: Uint8Array;
  readonly w: Uint8Array;
  readonly roomParams: RoomParams;
  readonly nickname: string;
  /** the inbound TCP+UDP port this peer owns (already mapped on the router) */
  readonly inboundPort: number;
  readonly inboundAddress?: string;
  /** room-code salt, so a promoted node can mint the new room code */
  readonly codeSalt?: Uint8Array;
  /**
   * Resolve this node's external IP:port for the new room code on promotion
   * (STUN + the existing NAT mapping). Omitted in tests / when no code is shown.
   */
  readonly resolveExternalEndpoint?: (
    port: number,
  ) => Promise<{ family: 'ipv4' | 'ipv6'; address: string; port: number }>;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatMaxMissed?: number;
  readonly staggerMs?: number;
  readonly reconnectAttempts?: number;
  readonly reconnectDelayMs?: number;
}

export interface PeerNodeEvents {
  roster: [RosterEntry[]];
  streams: [StreamInfo[]];
  /** media negotiation body from the host */
  media: [MediaBody];
  /** this node became the host; `code` is the new room code (null if not resolved) */
  promoted: [{ epoch: number; code: string | null }];
  /** this node re-homed to a new host */
  migrated: [{ epoch: number; hostPeerId: string }];
  /** the room ended - nobody could host */
  'room-closed': [{ reason: string }];
  error: [Error];
}

export class PeerNode extends EventEmitter<PeerNodeEvents> {
  readonly #opts: PeerNodeOptions;
  #client: SignalingClient | undefined;
  #server: SignalingServer | undefined;
  #responder: HeirProbeResponder | undefined;
  #bareListener: Server | undefined;
  #failover: Failover | undefined;
  #peerId = '';
  #epoch = 0;
  #roster: RosterEntry[] = [];
  #roomParams: RoomParams;
  #isHost = false;
  #shutdown = false;
  #expectClose = false;

  constructor(opts: PeerNodeOptions) {
    super();
    this.#opts = opts;
    this.#roomParams = opts.roomParams;
  }

  get peerId(): string {
    return this.#peerId;
  }
  get roster(): RosterEntry[] {
    return this.#isHost ? (this.#server?.roster ?? this.#roster) : this.#roster;
  }
  get epoch(): number {
    return this.#epoch;
  }
  get isHost(): boolean {
    return this.#isHost;
  }
  get streams(): StreamInfo[] {
    return this.#client?.streams ?? [];
  }

  /** Send a media negotiation body to the current host's SFU. */
  sendMedia(body: MediaBody): void {
    this.#client?.send(body);
  }

  async start(): Promise<void> {
    const address = this.#opts.inboundAddress ?? '127.0.0.1';

    this.#responder = new HeirProbeResponder(this.#opts.w, this.#opts.roomId);
    this.#responder.setStatus({ hostAlive: true, epoch: 0 });
    await this.#responder.listen(this.#opts.inboundPort, address);

    this.#bareListener = createServer((socket) => socket.on('error', () => {}));
    await new Promise<void>((resolve, reject) => {
      this.#bareListener!.once('error', reject);
      this.#bareListener!.listen(this.#opts.inboundPort, address, resolve);
    });

    await this.#connectClient({
      host: this.#opts.host,
      port: this.#opts.port,
      minEpoch: 0,
    });
  }

  async stop(): Promise<void> {
    this.#shutdown = true;
    this.#failover?.cancel();
    this.#expectClose = true;
    this.#client?.close('leaving');
    if (this.#server) await this.#server.close();
    this.#responder?.close();
    await new Promise<void>((resolve) => {
      if (!this.#bareListener) return resolve();
      this.#bareListener.close(() => resolve());
    });
  }

  // --- client lifecycle ---------------------------------------------------

  async #connectClient(target: {
    host: string;
    port: number;
    minEpoch: number;
  }): Promise<void> {
    const client = new SignalingClient({
      host: target.host,
      port: target.port,
      roomId: this.#opts.roomId,
      secret: { w: this.#opts.w },
      nickname: this.#opts.nickname,
      canHost: true,
      inboundPort: this.#opts.inboundPort,
      minEpoch: target.minEpoch,
      ...(this.#opts.heartbeatIntervalMs
        ? { heartbeatIntervalMs: this.#opts.heartbeatIntervalMs }
        : {}),
      ...(this.#opts.heartbeatMaxMissed
        ? { heartbeatMaxMissed: this.#opts.heartbeatMaxMissed }
        : {}),
    });

    const result = await client.connect();
    this.#client = client;
    this.#peerId = result.peerId;
    this.#epoch = client.epoch;
    this.#roster = result.roster;
    this.#roomParams = result.roomParams;
    this.#refreshResponder();
    this.emit('roster', this.#roster);
    this.emit('streams', result.streams);

    client.on('roster', (roster) => {
      this.#roster = roster;
      this.#refreshResponder();
      this.emit('roster', roster);
    });
    client.on('streams', (streams) => this.emit('streams', streams));
    client.on('media', (body) => this.emit('media', body));
    client.on('host-lost', () => this.#beginFailover());
    client.on('host-transfer', ({ successorPeerId, epoch }) => {
      this.#ensureFailover();
      this.#failover!.onGracefulTransfer(successorPeerId, epoch);
    });
    client.on('close', () => {
      if (this.#expectClose || this.#shutdown) {
        this.#expectClose = false;
        return;
      }
      this.#beginFailover();
    });
    client.on('error', (err) => this.emit('error', err));
  }

  #refreshResponder(): void {
    const hostAlive = !this.#isHost
      ? this.#client !== undefined
      : true;
    this.#responder?.setStatus({
      hostAlive: this.#isHost ? true : hostAlive,
      epoch: this.#epoch,
    });
  }

  // --- failover ---------------------------------------------------------

  #ensureFailover(): void {
    if (this.#failover) return;
    this.#failover = new Failover({
      selfPeerId: this.#peerId,
      currentEpoch: this.#epoch,
      roster: () => this.#roster,
      probe: (host, port) =>
        heirProbe(host, port, this.#opts.w, this.#opts.roomId),
      ...(this.#opts.staggerMs !== undefined
        ? { staggerMs: this.#opts.staggerMs }
        : {}),
    });
    this.#failover.on('action', (action) => void this.#applyAction(action));
  }

  #beginFailover(): void {
    if (this.#shutdown || this.#isHost) return;
    // the dead client is useless now
    this.#responder?.setStatus({ hostAlive: false, epoch: this.#epoch });
    this.#ensureFailover();
    this.#failover!.onHostLost();
  }

  async #applyAction(action: FailoverAction): Promise<void> {
    if (this.#shutdown) return;
    try {
      switch (action.type) {
        case 'promote':
          await this.#promote(action.epoch);
          break;
        case 'connect-heir':
          await this.#rehome(
            action.endpoint.address,
            action.endpoint.port,
            action.expectedEpoch,
            action.heirPeerId,
          );
          break;
        case 'reconnect-current':
          await this.#rehome(this.#opts.host, this.#opts.port, this.#epoch, null);
          break;
        case 'room-dead':
          this.#shutdown = true;
          this.emit('room-closed', { reason: action.reason });
          break;
      }
    } catch (err) {
      this.emit('error', err as Error);
      this.emit('room-closed', { reason: `failover failed: ${(err as Error).message}` });
    }
  }

  async #promote(epoch: number): Promise<void> {
    this.#failover?.cancel();
    this.#failover = undefined;
    const address = this.#opts.inboundAddress ?? '127.0.0.1';

    // hand the inbound port from the bare listener to the real server
    await new Promise<void>((resolve) => {
      if (!this.#bareListener) return resolve();
      this.#bareListener.close(() => resolve());
      this.#bareListener = undefined;
    });

    const server = new SignalingServer({
      roomId: this.#opts.roomId,
      w: this.#opts.w,
      roomParams: this.#roomParams,
      hostNickname: this.#opts.nickname,
      bindAddress: address,
      port: this.#opts.inboundPort,
      epoch,
      hostPeerId: this.#peerId,
      verifyInbound: true,
      ...(this.#opts.heartbeatIntervalMs
        ? { heartbeatIntervalMs: this.#opts.heartbeatIntervalMs }
        : {}),
      ...(this.#opts.heartbeatMaxMissed
        ? { heartbeatMaxMissed: this.#opts.heartbeatMaxMissed }
        : {}),
    });
    server.on('error', (err) => this.emit('error', err));
    const syncRoster = () => {
      this.#roster = server.roster;
      this.emit('roster', this.#roster);
    };
    server.on('peer-joined', syncRoster);
    server.on('peer-left', syncRoster);
    await server.listen();
    this.#server = server;
    this.#isHost = true;
    this.#epoch = epoch;
    this.#peerId = server.hostPeerId;
    this.#roster = server.roster;
    this.#responder?.setStatus({ hostAlive: true, epoch });

    // the promoted node IS the host; it reads the roster straight from the
    // server and runs no client of its own (matches the Phase 1 host).
    this.#expectClose = true;
    this.#client?.close('promoting');
    this.#client = undefined;

    let code: string | null = null;
    if (this.#opts.resolveExternalEndpoint && this.#opts.codeSalt) {
      try {
        const ext = await this.#opts.resolveExternalEndpoint(this.#opts.inboundPort);
        code = encodeRoomCode({
          version: 1,
          roomId: this.#opts.roomId,
          codeSalt: this.#opts.codeSalt,
          host: ext,
        });
      } catch (err) {
        this.emit('error', err as Error);
      }
    }
    this.emit('promoted', { epoch, code });
    this.emit('roster', this.#roster);
  }

  async #rehome(
    host: string,
    port: number,
    minEpoch: number,
    hostPeerId: string | null,
  ): Promise<void> {
    const attempts = this.#opts.reconnectAttempts ?? 20;
    const delayMs = this.#opts.reconnectDelayMs ?? 400;

    this.#expectClose = true;
    this.#client?.close('re-homing');
    this.#client = undefined;

    for (let i = 0; i < attempts && !this.#shutdown; i++) {
      try {
        await this.#connectClient({ host, port, minEpoch });
        this.#failover?.cancel();
        this.#failover = undefined;
        this.emit('migrated', {
          epoch: this.#epoch,
          hostPeerId: hostPeerId ?? this.#roster.find((e) => e.isHost)?.peerId ?? '',
        });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    if (!this.#shutdown) {
      this.emit('room-closed', { reason: 'could not reach the new host' });
    }
  }
}
