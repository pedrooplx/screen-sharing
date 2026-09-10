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
import { SfuMediaPlane } from '../sfu/media-plane.js';
import { primaryLanIpv4 } from '../net/local-ip.js';
import type {
  MediaBody,
  RoomCodeStatus,
  SessionPhase,
  SessionSnapshot,
} from '../../shared/ipc.js';
import type { RoomParams, RosterEntry, StreamInfo } from '../../shared/protocol.js';

const DEFAULT_ROOM_PARAMS: RoomParams = {
  maxParticipants: 12,
  maxRecommendedSubscriptions: 2,
  videoBitrateKbps: 2500,
};

export interface RoomSessionEvents {
  update: [SessionSnapshot];
  /** a media negotiation body destined for this participant's renderer */
  media: [MediaBody];
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

/** test-only (skipNat): a loopback port that is actually re-bindable now. */
async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const s = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () =>
        resolve((s.address() as { port: number }).port),
      );
    });
    await new Promise<void>((r) => s.close(() => r()));
    const ok = await new Promise<boolean>((resolve) => {
      const t = createServer();
      t.once('error', () => resolve(false));
      t.listen(port, '127.0.0.1', () => t.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error('no free loopback port');
}

export class RoomSession extends EventEmitter<RoomSessionEvents> {
  #phase: SessionPhase = 'idle';
  #nickname = '';
  #code: string | null = null;
  #codeStatus: RoomCodeStatus | null = null;
  #notice: string | null = null;

  #w: Uint8Array | null = null;
  #argonParams: ArgonParams | undefined;
  #roomParams: RoomParams = DEFAULT_ROOM_PARAMS;
  #server: SignalingServer | undefined;
  #node: PeerNode | undefined;
  #media: SfuMediaPlane | undefined;
  #closeMapping: (() => Promise<void>) | undefined;

  private constructor() {
    super();
  }

  // --- construction ----------------------------------------------------

  static async host(opts: HostOptions): Promise<RoomSession> {
    const session = new RoomSession();
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
    session.#roomParams = roomParams;

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
      // a promoted node runs an SFU of its own so media survives the failover
      sfu: {
        videoBitrateKbps: DEFAULT_ROOM_PARAMS.videoBitrateKbps,
        announceIp: () =>
          opts.skipNat ? undefined : (primaryLanIpv4() ?? undefined),
      },
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
    this.#media?.close();
    if (this.#closeMapping) await this.#closeMapping().catch(() => {});
    if (this.#w) wipe(this.#w);
    this.#w = null;
    this.#emit();
  }

  snapshot(): SessionSnapshot {
    // the PeerNode is authoritative once it exists (it knows if it promoted);
    // otherwise the original-host SignalingServer is.
    const node = this.#node;
    const isHost = node ? node.isHost : this.#server !== undefined;
    return {
      phase: this.#phase,
      isHost,
      selfPeerId: node ? node.peerId : (this.#server?.hostPeerId ?? ''),
      nickname: this.#nickname,
      epoch: node ? node.epoch : (this.#server?.epoch ?? 0),
      code: this.#code,
      codeStatus: this.#codeStatus,
      roster: node ? node.roster : (this.#server?.roster ?? []),
      streams: this.streams,
      maxRecommendedSubscriptions: (node?.roomParams ?? this.#roomParams)
        .maxRecommendedSubscriptions,
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
    const announceIp =
      this.#codeStatus && !this.#codeStatus.directlyReachable
        ? this.#codeStatus.externalAddress
        : (primaryLanIpv4() ?? undefined);
    const media = new SfuMediaPlane({
      videoBitrateKbps: roomParams.videoBitrateKbps,
      ...(announceIp ? { announceIp } : {}),
    });
    this.#media = media;

    const server = new SignalingServer({
      roomId,
      w: this.#w!,
      roomParams,
      hostNickname: this.#nickname,
      port,
      bindAddress,
      verifyInbound: true,
      media,
      ...(this.#argonParams ? { argonParams: this.#argonParams } : {}),
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
    await server.listen();
    this.#server = server;
  }

  // --- media (driven by the renderer through IPC) --------------------

  get streams(): StreamInfo[] {
    if (this.#media) return this.#media.listStreams();
    if (this.#node) return this.#node.streams;
    return [];
  }

  async sendMedia(body: MediaBody): Promise<void> {
    // original host: its own SFU. peer (incl. one that promoted): the node.
    if (this.#media && !this.#node) {
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
    this.#node?.sendMedia(body);
  }

  #wireNode(node: PeerNode): void {
    node.on('roster', () => this.#emit());
    node.on('streams', () => this.#emit());
    node.on('media', (body) => this.emit('media', body));
    node.on('promoted', ({ code }) => {
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
