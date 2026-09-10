/**
 * One live room membership, from the main process's point of view. Wraps the
 * two roles behind one interface the IPC layer can drive:
 *
 *   - host: a SignalingServer on the mapped port + the room code
 *   - peer: a PeerNode (client + heir-probe responder + failover)
 *
 * Emits `update` with a full SessionSnapshot whenever anything changes, so the
 * renderer only ever consumes immutable snapshots.
 */

import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  type ArgonParams,
  deriveArgonSalt,
  derivePasswordKey,
  wipe,
} from '../crypto/kdf.js';
import { discoverHostEndpoint } from '../room/host-endpoint.js';
import { decodeRoomCode, encodeRoomCode } from '../room/room-code.js';
import { discoverExternalAddress } from '../net/stun.js';
import { SignalingServer } from '../signaling/server.js';
import { PeerNode } from '../signaling/peer-node.js';
import type {
  RoomCodeStatus,
  SessionPhase,
  SessionSnapshot,
} from '../../shared/ipc.js';
import type { RoomParams, RosterEntry } from '../../shared/protocol.js';

const DEFAULT_ROOM_PARAMS: RoomParams = {
  maxParticipants: 12,
  maxRecommendedSubscriptions: 2,
  videoBitrateKbps: 2500,
};

export interface RoomSessionEvents {
  update: [SessionSnapshot];
}

export interface HostOptions {
  readonly nickname: string;
  readonly password: string;
  readonly port?: number;
  readonly roomParams?: RoomParams;
  readonly argonParams?: ArgonParams;
  /** tests only: skip STUN + NAT, host on 127.0.0.1 */
  readonly skipNat?: boolean;
  readonly bindAddress?: string;
}

export interface JoinOptions {
  readonly nickname: string;
  readonly password: string;
  readonly code: string;
  readonly inboundPort?: number;
  readonly argonParams?: ArgonParams;
  readonly skipNat?: boolean;
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

export class RoomSession extends EventEmitter<RoomSessionEvents> {
  #phase: SessionPhase = 'idle';
  #isHost = false;
  #nickname = '';
  #code: string | null = null;
  #codeStatus: RoomCodeStatus | null = null;
  #notice: string | null = null;

  #w: Uint8Array | null = null;
  #argonParams: ArgonParams | undefined;
  #server: SignalingServer | undefined;
  #node: PeerNode | undefined;
  #closeMapping: (() => Promise<void>) | undefined;

  private constructor() {
    super();
  }

  // --- construction ----------------------------------------------------

  static async host(opts: HostOptions): Promise<RoomSession> {
    const session = new RoomSession();
    session.#isHost = true;
    session.#nickname = opts.nickname;
    session.#phase = 'discovering';
    session.#emit();

    const roomId = new Uint8Array(randomBytes(4));
    const codeSalt = new Uint8Array(randomBytes(6));
    const argonSalt = deriveArgonSalt(roomId, codeSalt);
    session.#argonParams = opts.argonParams;
    session.#w = derivePasswordKey(opts.password, argonSalt, opts.argonParams);
    wipe(argonSalt);

    const port = opts.port ?? 47821;
    const roomParams = opts.roomParams ?? DEFAULT_ROOM_PARAMS;

    if (opts.skipNat) {
      const bound = await freePort();
      session.#code = encodeRoomCode({
        version: 1,
        roomId,
        codeSalt,
        host: { family: 'ipv4', address: '127.0.0.1', port: bound },
      });
      await session.#startServer(roomId, roomParams, bound, '127.0.0.1');
    } else {
      const info = await discoverHostEndpoint({ port, roomId, codeSalt });
      session.#closeMapping = info.close;
      session.#code = info.code;
      session.#codeStatus = {
        mappingMethod: info.mappingMethod,
        externalAddress: info.endpoint.address,
        directlyReachable: info.directlyReachable,
        blocker: info.blocker,
        manualForwardPort: info.blocker === 'no_inbound_path' ? port : null,
        manualForwardTo: info.blocker === 'no_inbound_path' ? '(seu IP local)' : null,
      };
      if (info.blocker === 'carrier_grade_nat') {
        session.#notice =
          'Seu provedor usa CGNAT — você não consegue ser host. Peça a outra pessoa.';
      } else if (info.blocker === 'no_inbound_path') {
        session.#notice = `Não foi possível abrir a porta automaticamente. Encaminhe TCP ${port} no seu roteador.`;
      }
      await session.#startServer(
        roomId,
        roomParams,
        port,
        opts.bindAddress ?? '0.0.0.0',
      );
    }

    session.#phase = 'hosting';
    session.#emit();
    return session;
  }

  static async join(opts: JoinOptions): Promise<RoomSession> {
    const session = new RoomSession();
    session.#nickname = opts.nickname;
    session.#phase = 'connecting';
    session.#emit();

    const decoded = decodeRoomCode(opts.code);
    const argonSalt = deriveArgonSalt(decoded.roomId, decoded.codeSalt);
    session.#w = derivePasswordKey(opts.password, argonSalt, opts.argonParams);
    wipe(argonSalt);

    const inboundPort = opts.skipNat
      ? await freePort()
      : (opts.inboundPort ?? 47822);

    const node = new PeerNode({
      host: decoded.host.address,
      port: decoded.host.port,
      roomId: decoded.roomId,
      w: session.#w,
      roomParams: DEFAULT_ROOM_PARAMS,
      nickname: opts.nickname,
      inboundPort,
      codeSalt: decoded.codeSalt,
      resolveExternalEndpoint: opts.skipNat
        ? async (p) => ({ family: 'ipv4', address: '127.0.0.1', port: p })
        : async (p) => {
            const ext = await discoverExternalAddress();
            return { family: ext.family, address: ext.address, port: p };
          },
    });
    session.#node = node;
    session.#wireNode(node);
    await node.start();

    session.#phase = 'in-room';
    session.#emit();
    return session;
  }

  // --- lifecycle -----------------------------------------------------

  async leave(): Promise<void> {
    this.#phase = 'left';
    if (this.#node) await this.#node.stop().catch(() => {});
    if (this.#server) await this.#server.close().catch(() => {});
    if (this.#closeMapping) await this.#closeMapping().catch(() => {});
    if (this.#w) wipe(this.#w);
    this.#w = null;
    this.#emit();
  }

  snapshot(): SessionSnapshot {
    const roster: RosterEntry[] = this.#isHost
      ? (this.#server?.roster ?? [])
      : (this.#node?.roster ?? []);
    return {
      phase: this.#phase,
      isHost: this.#isHost || (this.#node?.isHost ?? false),
      selfPeerId: this.#isHost
        ? (this.#server?.hostPeerId ?? '')
        : (this.#node?.peerId ?? ''),
      nickname: this.#nickname,
      epoch: this.#isHost ? (this.#server?.epoch ?? 0) : (this.#node?.epoch ?? 0),
      code: this.#code,
      codeStatus: this.#codeStatus,
      roster,
      notice: this.#notice,
    };
  }

  // --- internals ----------------------------------------------------

  async #startServer(
    roomId: Uint8Array,
    roomParams: RoomParams,
    port: number,
    bindAddress: string,
  ): Promise<void> {
    const server = new SignalingServer({
      roomId,
      w: this.#w!,
      roomParams,
      hostNickname: this.#nickname,
      port,
      bindAddress,
      verifyInbound: true,
      ...(this.#argonParams ? { argonParams: this.#argonParams } : {}),
    });
    server.on('peer-joined', () => this.#emit());
    server.on('peer-left', () => this.#emit());
    server.on('error', () => this.#emit());
    await server.listen();
    this.#server = server;
  }

  #wireNode(node: PeerNode): void {
    node.on('roster', () => this.#emit());
    node.on('promoted', ({ code }) => {
      this.#isHost = true;
      this.#phase = 'hosting';
      if (code) this.#code = code;
      this.#notice = 'Você virou o host desta sala.';
      this.#emit();
    });
    node.on('migrated', () => {
      this.#phase = 'in-room';
      this.#notice = 'O host mudou. Reconectado.';
      this.#emit();
    });
    node.on('room-closed', ({ reason }) => {
      this.#phase = 'left';
      this.#notice = `A sala encerrou: ${reason}`;
      this.#emit();
    });
    node.on('error', () => this.#emit());
  }

  #emit(): void {
    this.emit('update', this.snapshot());
  }
}
