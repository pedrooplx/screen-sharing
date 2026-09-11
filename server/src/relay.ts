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
  hostGone,
  peerDown,
  peerUp,
  pong,
  ready,
  reject,
  T,
} from './wire.js';

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
  readonly hostToken: string;
  host: Socket;
  readonly peers: Map<number, Socket>;
  nextConnId: number;
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
      const frame = decodeDataFromHost(data);
      if (!frame) return;
      room.peers.get(frame.connId)?.send(
        dataToPeer(frame.isBinary, frame.payload),
      );
    } else {
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
      // host gone -> tear the room down (no reconnect grace in v1)
      for (const peer of room.peers.values()) {
        peer.send(hostGone());
        peer.close(1001, 'host gone');
      }
      this.#rooms.delete(att.roomId);
    } else if (att.connId !== undefined) {
      room.peers.delete(att.connId);
      room.host.send(peerDown(att.connId));
    }
  }

  // --- helpers ------------------------------------------------------

  #hostHello(socket: Socket, hello: Hello): void {
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
    });
    this.#attached.set(socket, { role: 'host', roomId: hello.roomId });
    socket.send(ready({ hostToken }));
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

  /** drop stale rate buckets (call periodically) */
  sweep(): void {
    const now = this.#now();
    for (const [ip, bucket] of this.#rate) {
      const idle =
        bucket.creates.every((t) => now - t >= this.#limits.rateWindowMs) &&
        bucket.joins.every((t) => now - t >= this.#limits.rateWindowMs);
      if (idle) this.#rate.delete(ip);
    }
  }
}
