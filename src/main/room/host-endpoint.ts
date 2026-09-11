/**
 * Assembles everything a host needs to publish a room code (docs/DESIGN.md
 * section 8.1):
 *
 *   - external IP  <- STUN  (a UDP probe; STUN cannot see a TCP mapping)
 *   - external port <- the NAT mapping we asked for (or the manual port)
 *   - roomId + codeSalt <- fresh random
 *
 * Also reports the conditions that make hosting impossible so the UI can say so
 * plainly: carrier-grade NAT, or no inbound path at all.
 */

import { randomBytes } from 'node:crypto';
import {
  type ActiveMapping,
  mapInboundPort,
} from '../net/nat-mapping.js';
import {
  DEFAULT_STUN_SERVERS,
  type StunServer,
  discoverExternalAddress,
  isCarrierGradeNat,
} from '../net/stun.js';
import { allLanIpv4, primaryLanIpv4 } from '../net/local-ip.js';
import {
  CODE_SALT_BYTES,
  ROOM_ID_BYTES,
  type RoomCodeData,
  encodeRoomCode,
} from './room-code.js';

export type HostBlocker = 'carrier_grade_nat' | 'no_inbound_path' | null;

export interface HostEndpointInfo {
  readonly roomId: Uint8Array;
  readonly codeSalt: Uint8Array;
  readonly code: string;
  readonly endpoint: RoomCodeData['host'];
  /** how the port was opened */
  readonly mappingMethod: ActiveMapping['result']['method'];
  /** true when the external address equals a local one (host is not behind NAT) */
  readonly directlyReachable: boolean;
  /** non-null means the user cannot host as-is; the UI must surface it */
  readonly blocker: HostBlocker;
  /** this PC's LAN IPv4, to show in a manual port-forward instruction */
  readonly lanIp: string | null;
  /** release the NAT mapping on shutdown */
  close(): Promise<void>;
}

export interface DiscoverHostEndpointOptions {
  readonly port: number;
  readonly roomId?: Uint8Array;
  readonly codeSalt?: Uint8Array;
  readonly stunServers?: readonly StunServer[];
  /** skip NAT mapping and assume the user forwarded `port` themselves */
  readonly manualForwarding?: boolean;
}

export async function discoverHostEndpoint(
  opts: DiscoverHostEndpointOptions,
): Promise<HostEndpointInfo> {
  const roomId = opts.roomId ?? new Uint8Array(randomBytes(ROOM_ID_BYTES));
  const codeSalt = opts.codeSalt ?? new Uint8Array(randomBytes(CODE_SALT_BYTES));

  const mapping = opts.manualForwarding
    ? null
    : await mapInboundPort({ port: opts.port, description: 'erros-share room' });

  const external = await discoverExternalAddress(
    opts.stunServers ?? DEFAULT_STUN_SERVERS,
    { localPort: 0 },
  );

  const externalPort = mapping ? mapping.result.externalPort : opts.port;
  const method = mapping ? mapping.result.method : 'manual';
  const directlyReachable = allLanIpv4().includes(external.address);

  let blocker: HostBlocker = null;
  if (external.family === 'ipv4' && isCarrierGradeNat(external.address)) {
    blocker = 'carrier_grade_nat';
  } else if (method === 'manual' && !opts.manualForwarding && !directlyReachable) {
    blocker = 'no_inbound_path';
  }

  const endpoint: RoomCodeData['host'] = {
    family: external.family,
    address: external.address,
    port: externalPort,
  };

  const data: RoomCodeData = { version: 1, roomId, codeSalt, host: endpoint };

  return {
    roomId,
    codeSalt,
    code: encodeRoomCode(data),
    endpoint,
    mappingMethod: method,
    directlyReachable,
    blocker,
    lanIp: mapping?.result.internalHost ?? primaryLanIpv4(),
    close: async () => {
      await mapping?.close();
    },
  };
}
