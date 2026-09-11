import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { RoomSession } from '../../src/main/app/room-session.js';
import { decodeRoomCode, encodeRoomCode } from '../../src/main/room/room-code.js';
import type { HostEndpointInfo } from '../../src/main/room/host-endpoint.js';
import type { SessionSnapshot } from '../../src/shared/ipc.js';
import { MIN_ARGON_PARAMS } from '../../src/main/crypto/kdf.js';

let sessions: RoomSession[] = [];
afterEach(async () => {
  for (const s of sessions) await s.leave().catch(() => {});
  sessions = [];
});

const settle = () => new Promise((r) => setTimeout(r, 80));

function track(s: RoomSession): { last: SessionSnapshot } {
  const box = { last: s.snapshot() };
  s.on('update', (snap) => (box.last = snap));
  sessions.push(s);
  return box;
}

describe('RoomSession', () => {
  it('hosts a room and produces a decodable code', async () => {
    const host = await RoomSession.host({
      nickname: 'pedro',
      password: 'a-senha-boa',
      skipNat: true,
      argonParams: MIN_ARGON_PARAMS,
    });
    track(host);
    const snap = host.snapshot();

    expect(snap.phase).toBe('hosting');
    expect(snap.isHost).toBe(true);
    expect(snap.code).toBeTruthy();
    const decoded = decodeRoomCode(snap.code!);
    expect(decoded.host.address).toBe('127.0.0.1');
    expect(snap.roster).toHaveLength(1);
    expect(snap.roster[0]?.isHost).toBe(true);
  });

  it('lets a peer join with the code + password and both see the roster', async () => {
    const host = await RoomSession.host({
      nickname: 'host',
      password: 'segredo',
      skipNat: true,
      argonParams: MIN_ARGON_PARAMS,
    });
    const hostBox = track(host);

    const peer = await RoomSession.join({
      nickname: 'bob',
      password: 'segredo',
      code: host.snapshot().code!,
      skipNat: true,
      argonParams: MIN_ARGON_PARAMS,
    });
    const peerBox = track(peer);
    await settle();

    expect(peerBox.last.phase).toBe('in-room');
    expect(peerBox.last.roster.map((e) => e.nickname).sort()).toEqual(['bob', 'host']);
    expect(hostBox.last.roster.map((e) => e.nickname).sort()).toEqual(['bob', 'host']);
  });

  it('rejects a peer with the wrong password', async () => {
    const host = await RoomSession.host({
      nickname: 'host',
      password: 'certa',
      skipNat: true,
      argonParams: MIN_ARGON_PARAMS,
    });
    track(host);

    await expect(
      RoomSession.join({
        nickname: 'mallory',
        password: 'errada',
        code: host.snapshot().code!,
        skipNat: true,
      argonParams: MIN_ARGON_PARAMS,
      }),
    ).rejects.toThrow();
    await settle();
    expect(host.snapshot().roster).toHaveLength(1);
  });

  it('drops the peer from the host roster on leave', async () => {
    const host = await RoomSession.host({
      nickname: 'host',
      password: 'x',
      skipNat: true,
      argonParams: MIN_ARGON_PARAMS,
    });
    const hostBox = track(host);
    const peer = await RoomSession.join({
      nickname: 'carol',
      password: 'x',
      code: host.snapshot().code!,
      skipNat: true,
      argonParams: MIN_ARGON_PARAMS,
    });
    sessions.push(peer);
    await settle();
    expect(hostBox.last.roster).toHaveLength(2);

    await peer.leave();
    await settle();
    expect(hostBox.last.roster.map((e) => e.nickname)).toEqual(['host']);
  });

  it('offers a retry that re-runs port mapping and clears the blocker', async () => {
    const bound = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });

    let attempt = 0;
    const discover = async ({
      roomId,
      codeSalt,
      port,
    }: {
      port: number;
      roomId?: Uint8Array;
      codeSalt?: Uint8Array;
    }): Promise<HostEndpointInfo> => {
      attempt++;
      const open = attempt >= 2; // first call fails, retry succeeds
      const host = {
        family: 'ipv4' as const,
        address: '203.0.113.9',
        port: bound,
      };
      return {
        roomId: roomId!,
        codeSalt: codeSalt!,
        code: encodeRoomCode({ version: 1, roomId: roomId!, codeSalt: codeSalt!, host }),
        endpoint: host,
        mappingMethod: open ? 'upnp' : 'manual',
        directlyReachable: false,
        blocker: open ? null : 'no_inbound_path',
        lanIp: '192.168.0.42',
        close: async () => {},
      };
    };

    const host = await RoomSession.host({
      nickname: 'pedro',
      password: 'x',
      port: bound,
      argonParams: MIN_ARGON_PARAMS,
      discover: discover as never,
      bindAddress: '127.0.0.1',
    });
    const box = track(host);

    expect(box.last.codeStatus?.blocker).toBe('no_inbound_path');
    expect(box.last.canRetryMapping).toBe(true);
    expect(box.last.codeStatus?.manualForwardTo).toBe('192.168.0.42');

    await host.retryHostMapping();

    expect(box.last.codeStatus?.blocker).toBeNull();
    expect(box.last.codeStatus?.mappingMethod).toBe('upnp');
    expect(box.last.canRetryMapping).toBe(false);
    expect(box.last.notice).toMatch(/pronto para hospedar/i);
  });
});
