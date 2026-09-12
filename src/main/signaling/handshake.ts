/**
 * Drives the CPace handshake over a Connection, for both roles.
 *
 * Sequence (docs/DESIGN.md section 7.1):
 *   peer -> host  hello        {appVersion, protoVersion, roomId}
 *   host -> peer  hello_ack    {sid, protoVersion, argonParams}
 *   peer -> host  pake_peer    {ya}
 *   host -> peer  pake_host    {yb, macHost}
 *   peer -> host  pake_confirm {macPeer}
 *   -- both sides upgrade the Connection to encrypted framing --
 *
 * A wrong password fails at `pake_confirm`: the peer throws when it cannot
 * verify `macHost`, the host's `verifyPeer` returns false. Either way no room
 * information has been exchanged.
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Connection } from '../net/connection.js';
import {
  type CpaceBinding,
  CpaceError,
  hostRespond,
  newSid,
  peerBegin,
} from '../crypto/cpace.js';
import {
  type ArgonParams,
  DEFAULT_ARGON_PARAMS,
  argonParamsAcceptable,
  deriveTransportKeys,
} from '../crypto/kdf.js';
import {
  APP_VERSION,
  type HandshakeMessage,
  PROTOCOL_VERSION,
  ProtocolError,
} from '../../shared/protocol.js';

export class HandshakeError extends Error {
  override name = 'HandshakeError';
  constructor(
    message: string,
    readonly reason:
      | 'room_id_mismatch'
      | 'version_mismatch'
      | 'bad_password'
      | 'bad_message'
      | 'timeout'
      | 'closed',
  ) {
    super(message);
  }
}

const HANDSHAKE_TIMEOUT_MS = 10_000;

function waitFor<T extends HandshakeMessage['type']>(
  conn: Connection,
  type: T,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
): Promise<Extract<HandshakeMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new HandshakeError(`timed out waiting for ${type}`, 'timeout'));
    }, timeoutMs);
    const onHandshake = (msg: HandshakeMessage) => {
      if (msg.type === 'handshake_reject') {
        cleanup();
        reject(new HandshakeError(`rejected: ${msg.reason}`, 'bad_message'));
        return;
      }
      if (msg.type !== type) {
        cleanup();
        reject(
          new HandshakeError(`expected ${type}, got ${msg.type}`, 'bad_message'),
        );
        return;
      }
      cleanup();
      resolve(msg as Extract<HandshakeMessage, { type: T }>);
    };
    const onClose = () => {
      cleanup();
      reject(new HandshakeError('connection closed mid-handshake', 'closed'));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(new HandshakeError(err.message, 'bad_message'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      conn.off('handshake', onHandshake);
      conn.off('close', onClose);
      conn.off('error', onError);
    };
    conn.on('handshake', onHandshake);
    conn.on('close', onClose);
    conn.on('error', onError);
  });
}

export interface HandshakeResult {
  readonly isk: Uint8Array;
}

// --- Host -----------------------------------------------------------------

export interface HostHandshakeConfig {
  readonly roomId: Uint8Array;
  readonly w: Uint8Array;
  readonly argonParams?: ArgonParams;
}

export async function runHostHandshake(
  conn: Connection,
  cfg: HostHandshakeConfig,
): Promise<HandshakeResult> {
  const hello = await waitFor(conn, 'hello');
  if (hello.protoVersion !== PROTOCOL_VERSION) {
    conn.sendHandshake({ type: 'handshake_reject', reason: 'version_mismatch' });
    throw new HandshakeError('peer protocol version mismatch', 'version_mismatch');
  }
  if (hello.roomId !== bytesToHex(cfg.roomId)) {
    conn.sendHandshake({ type: 'handshake_reject', reason: 'room_id_mismatch' });
    throw new HandshakeError('peer targeted a different room', 'room_id_mismatch');
  }

  const sid = newSid();
  const argonParams = cfg.argonParams ?? DEFAULT_ARGON_PARAMS;
  conn.sendHandshake({
    type: 'hello_ack',
    protoVersion: PROTOCOL_VERSION,
    sid: bytesToHex(sid),
    argonParams,
  });

  const pakePeer = await waitFor(conn, 'pake_peer');
  const binding: CpaceBinding = {
    roomId: cfg.roomId,
    protocolVersion: PROTOCOL_VERSION,
  };

  let host;
  try {
    host = hostRespond(cfg.w, binding, sid, hexToBytes(pakePeer.ya));
  } catch (err) {
    if (err instanceof CpaceError) {
      throw new HandshakeError(err.message, 'bad_message');
    }
    throw err;
  }

  conn.sendHandshake({
    type: 'pake_host',
    yb: bytesToHex(host.yb),
    macHost: bytesToHex(host.macHost),
  });

  const confirm = await waitFor(conn, 'pake_confirm');
  if (!host.verifyPeer(hexToBytes(confirm.macPeer))) {
    throw new HandshakeError('peer key confirmation failed', 'bad_password');
  }

  conn.upgrade(deriveTransportKeys(host.isk));
  return { isk: host.isk };
}

// --- Peer -----------------------------------------------------------------

export interface PeerHandshakeConfig {
  readonly roomId: Uint8Array;
  /** derive `w` once the host's argonParams are known */
  readonly deriveW: (params: ArgonParams) => Uint8Array | Promise<Uint8Array>;
  /**
   * Per-step timeout (default 10s). Shortened by RoomSession while
   * re-homing to a host that just took over via a graceful handoff - the
   * usual 10s is fine when a host is already known-good, but a survivor
   * retrying every 10s while the successor is still coming up would make a
   * handoff feel far slower than it is.
   */
  readonly timeoutMs?: number;
}

export async function runPeerHandshake(
  conn: Connection,
  cfg: PeerHandshakeConfig,
): Promise<HandshakeResult> {
  conn.sendHandshake({
    type: 'hello',
    appVersion: APP_VERSION,
    protoVersion: PROTOCOL_VERSION,
    roomId: bytesToHex(cfg.roomId),
  });

  const ack = await waitFor(conn, 'hello_ack', cfg.timeoutMs);
  if (ack.protoVersion !== PROTOCOL_VERSION) {
    throw new HandshakeError('host protocol version mismatch', 'version_mismatch');
  }
  if (!argonParamsAcceptable(ack.argonParams)) {
    throw new HandshakeError(
      'host proposed weaker-than-allowed password hardening',
      'bad_message',
    );
  }

  const w = await cfg.deriveW(ack.argonParams);
  const binding: CpaceBinding = {
    roomId: cfg.roomId,
    protocolVersion: PROTOCOL_VERSION,
  };
  const peer = peerBegin(w, binding, hexToBytes(ack.sid));
  conn.sendHandshake({ type: 'pake_peer', ya: bytesToHex(peer.ya) });

  const pakeHost = await waitFor(conn, 'pake_host', cfg.timeoutMs);
  let result;
  try {
    result = peer.finish(hexToBytes(pakeHost.yb), hexToBytes(pakeHost.macHost));
  } catch (err) {
    if (err instanceof CpaceError) {
      conn.sendHandshake({ type: 'handshake_reject', reason: 'bad_message' });
      throw new HandshakeError(err.message, 'bad_message');
    }
    throw err;
  }

  // Always answer so the host is not left waiting; if the password was wrong
  // the host's verifyPeer will also fail and it will drop us.
  conn.sendHandshake({
    type: 'pake_confirm',
    macPeer: bytesToHex(result.macPeer),
  });

  if (!result.hostConfirmed) {
    throw new HandshakeError(
      'host key confirmation failed (wrong password?)',
      'bad_password',
    );
  }

  conn.upgrade(deriveTransportKeys(result.isk));
  return { isk: result.isk };
}

export { ProtocolError };
