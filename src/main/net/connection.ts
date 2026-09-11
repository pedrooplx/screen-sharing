/**
 * A single control-plane connection between a peer and the host.
 *
 * Lifecycle:
 *   1. handshake phase - ws TEXT frames carrying plaintext JSON
 *      (HandshakeMessage). CPace runs here.
 *   2. after `upgrade()` - ws BINARY frames carrying AES-256-GCM `Envelope`s.
 *
 * A frame of the wrong kind for the current phase is a fatal protocol error:
 * the connection emits `error` and closes.
 */

import { EventEmitter } from 'node:events';
import type { Transport } from './transport.js';
import {
  Direction,
  FrameDecoder,
  FrameEncoder,
} from './frame-codec.js';
import {
  type Body,
  type Envelope,
  type HandshakeMessage,
  ProtocolError,
  PROTOCOL_VERSION,
  envelopeSchema,
  handshakeMessageSchema,
  parseJson,
} from '../../shared/protocol.js';
import type { TransportKeys } from '../crypto/kdf.js';

export interface ConnectionEvents {
  handshake: [HandshakeMessage];
  message: [Envelope];
  close: [{ code: number; reason: string }];
  error: [Error];
}

export type ConnectionRole = 'host' | 'peer';

type InboxItem =
  | { ev: 'handshake'; data: HandshakeMessage }
  | { ev: 'message'; data: Envelope };

export class Connection extends EventEmitter<ConnectionEvents> {
  readonly #transport: Transport;
  readonly #role: ConnectionRole;
  #encoder: FrameEncoder | undefined;
  #decoder: FrameDecoder | undefined;
  #pendingBinary: Buffer[] = [];
  /** decoded inbound events held until a consumer is listening */
  #inbox: InboxItem[] = [];
  #closed = false;

  /** identity stamped into the `from` field of outbound envelopes */
  outboundFrom = 'unknown';
  epoch = 0;
  #seq = 0;

  constructor(transport: Transport, role: ConnectionRole) {
    super();
    this.#transport = transport;
    this.#role = role;

    (this as EventEmitter).on('newListener', (event: string | symbol) => {
      if (event === 'handshake' || event === 'message') {
        queueMicrotask(() => this.#flush());
      }
    });

    transport.onMessage((data, isBinary) => {
      try {
        this.#onMessage(data, isBinary);
      } catch (err) {
        this.#fail(err as Error);
      }
    });
    transport.onClose((code, reason) => {
      this.#closed = true;
      this.emit('close', { code, reason });
    });
    transport.onError((err) => this.#fail(err));
  }

  get encrypted(): boolean {
    return this.#encoder !== undefined;
  }

  get closed(): boolean {
    return this.#closed || this.#transport.closed;
  }

  sendHandshake(msg: HandshakeMessage): void {
    if (this.encrypted) throw new ProtocolError('handshake after upgrade');
    this.#transport.send(JSON.stringify(msg), false);
  }

  /**
   * Switch to encrypted framing. `keys` is the pair derived from the CPace ISK;
   * the host sends on s2c and receives on c2s, the peer the other way around.
   */
  upgrade(keys: TransportKeys): void {
    if (this.encrypted) throw new ProtocolError('already upgraded');
    const send = this.#role === 'host' ? keys.s2c : keys.c2s;
    const recv = this.#role === 'host' ? keys.c2s : keys.s2c;
    const sendDir =
      this.#role === 'host'
        ? Direction.ServerToClient
        : Direction.ClientToServer;
    const recvDir =
      this.#role === 'host'
        ? Direction.ClientToServer
        : Direction.ServerToClient;
    this.#encoder = new FrameEncoder(send.key, send.nonceSalt, sendDir);
    this.#decoder = new FrameDecoder(recv.key, recv.nonceSalt, recvDir);

    // The other side may have upgraded and sent its first encrypted frame(s)
    // in the same TCP segment as its `pake_confirm`, so `ws` can deliver them
    // before this microtask ran. Drain anything that arrived early.
    const early = this.#pendingBinary;
    this.#pendingBinary = [];
    for (const frame of early) this.#onMessage(frame, true);
  }

  send(body: Body): void {
    if (!this.#encoder) throw new ProtocolError('send before upgrade');
    const envelope: Envelope = {
      v: PROTOCOL_VERSION,
      epoch: this.epoch,
      seq: this.#seq++,
      from: this.outboundFrom,
      body,
    };
    const frame = this.#encoder.encode(Buffer.from(JSON.stringify(envelope)));
    this.#transport.send(frame, true);
  }

  close(code = 1000, reason = ''): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#transport.close(code, reason);
  }

  #onMessage(data: Buffer, isBinary: boolean): void {
    if (this.encrypted) {
      if (!isBinary) throw new ProtocolError('text frame after upgrade');
      const plaintext = this.#decoder!.decode(data);
      const envelope = parseJson(
        envelopeSchema,
        Buffer.from(plaintext).toString('utf8'),
      );
      if (envelope.v !== PROTOCOL_VERSION) {
        throw new ProtocolError(`envelope version ${envelope.v}`);
      }
      this.#deliver({ ev: 'message', data: envelope });
      return;
    }
    if (isBinary) {
      // Arrived before our own upgrade() ran; replay it once we have keys.
      if (this.#pendingBinary.length < 64) {
        this.#pendingBinary.push(Buffer.from(data));
        return;
      }
      throw new ProtocolError('too many binary frames before upgrade');
    }
    const msg = parseJson(handshakeMessageSchema, data.toString('utf8'));
    this.#deliver({ ev: 'handshake', data: msg });
  }

  /** Emit now if someone is listening, otherwise hold it in the inbox. */
  #deliver(item: InboxItem): void {
    if (this.listenerCount(item.ev) > 0) {
      this.emit(item.ev, item.data as never);
    } else {
      this.#inbox.push(item);
    }
  }

  #flush(): void {
    if (this.#inbox.length === 0) return;
    const held = this.#inbox;
    this.#inbox = [];
    for (const item of held) {
      if (this.listenerCount(item.ev) > 0) {
        this.emit(item.ev, item.data as never);
      } else {
        this.#inbox.push(item);
      }
    }
  }

  #fail(err: Error): void {
    if (this.#closed) return;
    this.emit('error', err);
    this.close(1002, 'protocol error');
  }
}
