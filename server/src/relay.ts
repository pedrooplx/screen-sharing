/**
 * The relay's room registry and message routing. Transport-agnostic: it works
 * with a minimal `Socket` shape so it can be unit-tested with fakes.
 *
 * One room = one host socket + N peer sockets. The relay assigns each peer a
 * numeric connId and shuttles opaque payloads between the peer and the host,
 * tagging host-bound frames with the connId. It authenticates nothing at the
 * app level (CPace does that end to end); it only enforces resource limits.
 */

import { randomBytes } from 'node:crypto';
import {
  RELAY_PROTOCOL_VERSION,
  type Hello,
  type RejectReason,
  dataToHost,
  dataToPeer,
  decodeDataFromHost,
  decodeDataFromPeer,
  decodeKick,
  hostGone,
  peerDown,
  peerUp,
  pong,
  ready,
  reject,
  T,
} from './wire.js';

/** how long a room stays reserved for a successor after its host hands off
 *  gracefully (HANDOFF) before falling back to the normal teardown */
const HANDOFF_GRACE_MS = 8_000;

export interface Socket {
  send(data: Buffer): void;
  close(code?: number, reason?: string): void;
  readonly ip: string;
}

export interface RelayLimits {
  readonly maxRooms: number;
  readonly maxPeersPerRoom: number;
  readonly roomCreatesPerWindow: number;
  readonly joinsPerWindow: number;
  readonly rateWindowMs: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  maxRooms: 500,
  maxPeersPerRoom: 24,
  roomCreatesPerWindow: 10,
  joinsPerWindow: 40,
  rateWindowMs: 60_000,
};

interface Room {
  readonly roomId: string;
  hostToken: string;
  host: Socket;
  readonly peers: Map<number, Socket>;
  nextConnId: number;
  /** set by HANDOFF; a fresh host HELLO for this roomId claims the room
   *  instead of being rejected with room_exists until this passes */
  handoffDeadline: number | undefined;
}

interface Attached {
  role: 'host' | 'peer';
  roomId: string;
  connId?: number;
}

export class Relay {
  readonly #rooms = new Map<string, Room>();
  readonly #attached = new WeakMap<Socket, Attached>();
  readonly #rate = new Map<string, { creates: number[]; joins: number[] }>();
  readonly #limits: RelayLimits;
  readonly #now: () => number;

  constructor(limits: RelayLimits = DEFAULT_LIMITS, now: () => number = Date.now) {
    this.#limits = limits;
    this.#now = now;
  }

  get roomCount(): number {
    return this.#rooms.size;
  }

  peerCount(roomId: string): number {
    return this.#rooms.get(roomId)?.peers.size ?? 0;
  }

  // --- connection lifecycle -----------------------------------------

  onHello(socket: Socket, hello: Hello): void {
    if (this.#attached.has(socket)) {
      this.#kick(socket, 'bad_hello');
      return;
    }
    if (hello.proto !== RELAY_PROTOCOL_VERSION) {
      this.#kick(socket, 'proto_mismatch');
      return;
    }
    if (hello.role === 'host') this.#hostHello(socket, hello);
    else this.#peerHello(socket, hello);
  }

  onMessage(socket: Socket, data: Buffer): void {
    const type = data[0];
    if (type === T.PING) {
      socket.send(pong());
      return;
    }
    const att = this.#attached.get(socket);
    if (!att) return;
    const room = this.#rooms.get(att.roomId);
    if (!room) return;

    if (att.role === 'host') {
      if (type === T.KICK) {
        const connId = decodeKick(data);
        const peer = connId !== null ? room.peers.get(connId) : undefined;
        if (peer && connId !== null) {
          room.peers.delete(connId);
          peer.close(1000, 'kicked');
        }
        return;
      }
      if (type === T.HANDOFF) {
        // Only the room's current host can start a handoff - a stale
        // reference (already superseded by an earlier claim) is a no-op.
        if (room.host === socket) {
          room.handoffDeadline = this.#now() + HANDOFF_GRACE_MS;
        }
        return;
      }
      const frame = decodeDataFromHost(data);
      if (!frame) return;
      room.peers.get(frame.connId)?.send(
        dataToPeer(frame.isBinary, frame.payload),
      );
    } else {
      // A handoff is pending: room.host is the departing host, still
      // technically connected (it lingers until its own close arrives or the
      // grace window lapses - see onClose/sweep below) but no longer a valid
      // destination. Forwarding to it anyway would hand a plaintext `hello`
      // (a survivor's fresh handshake attempt, see RoomSession#rehome) to a
      // Connection object that already upgraded to encrypted framing on its
      // original handshake - a confusing protocol violation on arrival, not
      // a clean rejection. Silently drop instead: RoomSession#rehome waits a
      // short beat before its one handshake attempt specifically so this
      // window is rarely hit, but a survivor that reacts before the
      // successor's claim still fails clean instead of crashing anything.
      if (room.handoffDeadline !== undefined) return;
      const frame = decodeDataFromPeer(data);
      if (!frame || att.connId === undefined) return;
      room.host.send(dataToHost(att.connId, frame.isBinary, frame.payload));
    }
  }

  onClose(socket: Socket): void {
    const att = this.#attached.get(socket);
    if (!att) return;
    this.#attached.delete(socket);
    const room = this.#rooms.get(att.roomId);
    if (!room) return;

    if (att.role === 'host') {
      if (room.host !== socket) {
        // a stale reference: this host was already superseded by a
        // successor's claim (#hostHello below) - nothing to do here, the
        // room and its peers now belong to that new host.
        return;
      }
      if (room.handoffDeadline !== undefined) {
        // graceful handoff in flight (HANDOFF already received): leave the
        // room and its peers alone and let the grace window (sweep()) or a
        // successor's claim resolve it, instead of tearing down right away.
        return;
      }
      // host gone with no handoff pending -> tear the room down immediately,
      // exactly as before (a crash or an abrupt disconnect, not a leave()).
      this.#teardownRoom(room);
    } else if (att.connId !== undefined) {
      room.peers.delete(att.connId);
      room.host.send(peerDown(att.connId));
    }
  }

  // --- helpers ------------------------------------------------------

  #hostHello(socket: Socket, hello: Hello): void {
    const existing = this.#rooms.get(hello.roomId);
    if (
      existing?.handoffDeadline !== undefined &&
      this.#now() < existing.handoffDeadline
    ) {
      this.#claimHandoff(socket, existing);
      return;
    }
    if (this.#rooms.size >= this.#limits.maxRooms) {
      this.#kick(socket, 'server_full');
      return;
    }
    if (!this.#allow(socket.ip, 'creates')) {
      this.#kick(socket, 'rate_limited');
      return;
    }
    if (this.#rooms.has(hello.roomId)) {
      this.#kick(socket, 'room_exists');
      return;
    }
    const hostToken = randomBytes(16).toString('hex');
    this.#rooms.set(hello.roomId, {
      roomId: hello.roomId,
      hostToken,
      host: socket,
      peers: new Map(),
      nextConnId: 1,
      handoffDeadline: undefined,
    });
    this.#attached.set(socket, { role: 'host', roomId: hello.roomId });
    socket.send(ready({ hostToken }));
  }

  /**
   * A new host HELLO arrived while `room` is in its post-HANDOFF grace
   * window: treat it as the successor claiming the room instead of a
   * conflicting create. Not gated by maxRooms/rate limits - the room already
   * exists, this only changes who owns it. Every peer still connected gets a
   * fresh PEER_UP to the new host socket, exactly as if they had just
   * dialed in, so the new host's SignalingServer re-handshakes each one.
   */
  #claimHandoff(socket: Socket, room: Room): void {
    room.host = socket;
    room.handoffDeadline = undefined;
    room.hostToken = randomBytes(16).toString('hex');
    this.#attached.set(socket, { role: 'host', roomId: room.roomId });
    socket.send(ready({ hostToken: room.hostToken }));
    for (const connId of room.peers.keys()) {
      socket.send(peerUp(connId));
    }
  }

  #teardownRoom(room: Room): void {
    for (const peer of room.peers.values()) {
      peer.send(hostGone());
      peer.close(1001, 'host gone');
    }
    this.#rooms.delete(room.roomId);
  }

  #peerHello(socket: Socket, hello: Hello): void {
    const room = this.#rooms.get(hello.roomId);
    if (!room) {
      this.#kick(socket, 'no_such_room');
      return;
    }
    if (room.peers.size >= this.#limits.maxPeersPerRoom) {
      this.#kick(socket, 'room_full');
      return;
    }
    if (!this.#allow(socket.ip, 'joins')) {
      this.#kick(socket, 'rate_limited');
      return;
    }
    const connId = room.nextConnId++;
    room.peers.set(connId, socket);
    this.#attached.set(socket, { role: 'peer', roomId: hello.roomId, connId });
    socket.send(ready({ connId }));
    room.host.send(peerUp(connId));
  }

  #kick(socket: Socket, reason: RejectReason): void {
    socket.send(reject(reason));
    socket.close(1008, reason);
  }

  #allow(ip: string, kind: 'creates' | 'joins'): boolean {
    const now = this.#now();
    const bucket = this.#rate.get(ip) ?? { creates: [], joins: [] };
    this.#rate.set(ip, bucket);
    const arr = bucket[kind];
    const fresh = arr.filter((t) => now - t < this.#limits.rateWindowMs);
    bucket[kind] = fresh;
    const cap =
      kind === 'creates'
        ? this.#limits.roomCreatesPerWindow
        : this.#limits.joinsPerWindow;
    if (fresh.length >= cap) return false;
    fresh.push(now);
    return true;
  }

  /**
   * Drop stale rate buckets, and finish off any room whose graceful-handoff
   * grace window (HANDOFF_GRACE_MS) elapsed with nobody claiming it - nobody
   * was reachable, or the intended successor never came online. Call this
   * periodically; how periodically bounds how long a failed handoff leaves
   * peers waiting before they're told the room is actually gone (see
   * server/src/index.ts - this needs to run far more often than the
   * rate-bucket cleanup alone would justify).
   */
  sweep(): void {
    const now = this.#now();
    for (const room of this.#rooms.values()) {
      if (room.handoffDeadline !== undefined && now >= room.handoffDeadline) {
        this.#teardownRoom(room);
      }
    }
    for (const [ip, bucket] of this.#rate) {
      const idle =
        bucket.creates.every((t) => now - t >= this.#limits.rateWindowMs) &&
        bucket.joins.every((t) => now - t >= this.#limits.rateWindowMs);
      if (idle) this.#rate.delete(ip);
    }
  }
}
