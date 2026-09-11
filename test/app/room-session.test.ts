import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RoomSession } from '../../src/main/app/room-session.js';
import { decodeRoomCode } from '../../src/main/room/room-code.js';
import type { SessionSnapshot } from '../../src/shared/ipc.js';
import { MIN_ARGON_PARAMS } from '../../src/main/crypto/kdf.js';
import { startTestRelay, type TestRelay } from '../helpers/relay.js';

let relay: TestRelay;
beforeAll(async () => {
  relay = await startTestRelay();
});
afterAll(async () => {
  await relay.close();
});

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

describe('RoomSession (over the relay)', () => {
  it('hosts a room and produces a decodable code', async () => {
    const host = await RoomSession.host({
      nickname: 'pedro',
      password: 'a-senha-boa',
      relayUrl: relay.url,
      argonParams: MIN_ARGON_PARAMS,
    });
    track(host);
    const snap = host.snapshot();

    expect(snap.phase).toBe('hosting');
    expect(snap.isHost).toBe(true);
    expect(snap.code).toBeTruthy();
    const decoded = decodeRoomCode(snap.code!);
    expect(decoded.roomId).toHaveLength(4);
    expect(snap.roster).toHaveLength(1);
    expect(snap.roster[0]?.isHost).toBe(true);
  });

  it('lets a peer join with the code + password and both see the roster', async () => {
    const host = await RoomSession.host({
      nickname: 'host',
      password: 'segredo',
      relayUrl: relay.url,
      argonParams: MIN_ARGON_PARAMS,
    });
    const hostBox = track(host);

    const peer = await RoomSession.join({
      nickname: 'bob',
      password: 'segredo',
      code: host.snapshot().code!,
      relayUrl: relay.url,
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
      relayUrl: relay.url,
      argonParams: MIN_ARGON_PARAMS,
    });
    track(host);

    await expect(
      RoomSession.join({
        nickname: 'mallory',
        password: 'errada',
        code: host.snapshot().code!,
        relayUrl: relay.url,
      }),
    ).rejects.toThrow();
    await settle();
    expect(host.snapshot().roster).toHaveLength(1);
  });

  it('rejects a code from a room that does not exist on this relay', async () => {
    // a syntactically valid code, but no host ever registered that roomId
    const ghost = await RoomSession.host({
      nickname: 'temp',
      password: 'x',
      relayUrl: relay.url,
      argonParams: MIN_ARGON_PARAMS,
    });
    track(ghost);
    const ghostCode = ghost.snapshot().code!;
    await ghost.leave();
    await settle();

    await expect(
      RoomSession.join({
        nickname: 'nobody-home',
        password: 'x',
        code: ghostCode,
        relayUrl: relay.url,
      }),
    ).rejects.toThrow(/no_such_room|rejected/i);
  });

  it('does not leave a dangling host link if leave() races the initial connect', async () => {
    const session = RoomSession.begin();
    track(session);
    // leave() fires while host()'s relay connect is still in flight - it must
    // not resolve into a live 'hosting' session, and must not leak the link.
    const hostPromise = session.host({
      nickname: 'race',
      password: 'x',
      relayUrl: relay.url,
      argonParams: MIN_ARGON_PARAMS,
    });
    await session.leave();
    await hostPromise;

    const snap = session.snapshot();
    expect(snap.phase).toBe('left');
    expect(snap.isHost).toBe(false);

    // give the relay a moment to process the host socket's close, then prove
    // the room was actually torn down there too (not just locally).
    await settle();
    await expect(
      RoomSession.join({
        nickname: 'nobody-home',
        password: 'x',
        code: snap.code!,
        relayUrl: relay.url,
      }),
    ).rejects.toThrow(/no_such_room/i);
  });

  it('drops the peer from the host roster on leave', async () => {
    const host = await RoomSession.host({
      nickname: 'host',
      password: 'x',
      relayUrl: relay.url,
      argonParams: MIN_ARGON_PARAMS,
    });
    const hostBox = track(host);
    const peer = await RoomSession.join({
      nickname: 'carol',
      password: 'x',
      code: host.snapshot().code!,
      relayUrl: relay.url,
    });
    sessions.push(peer);
    await settle();
    expect(hostBox.last.roster).toHaveLength(2);

    await peer.leave();
    await settle();
    expect(hostBox.last.roster.map((e) => e.nickname)).toEqual(['host']);
  });

  it('ends the peer session when the relay itself goes away', async () => {
    const oneOffRelay = await startTestRelay();
    const host = await RoomSession.host({
      nickname: 'host',
      password: 'x',
      relayUrl: oneOffRelay.url,
      argonParams: MIN_ARGON_PARAMS,
    });
    track(host);
    const peer = await RoomSession.join({
      nickname: 'dana',
      password: 'x',
      code: host.snapshot().code!,
      relayUrl: oneOffRelay.url,
    });
    const peerBox = track(peer);
    await settle();

    await oneOffRelay.close();
    await settle();

    expect(peerBox.last.phase).toBe('left');
    expect(peerBox.last.notice).toBeTruthy();
  });
});
