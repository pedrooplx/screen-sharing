import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RoomSession } from '../../src/main/app/room-session.js';
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
  it('hosts the (single, fixed) room', async () => {
    const host = await RoomSession.host({
      nickname: 'pedro',
      relayUrl: relay.url,
      argonParams: MIN_ARGON_PARAMS,
    });
    track(host);
    const snap = host.snapshot();

    expect(snap.phase).toBe('hosting');
    expect(snap.isHost).toBe(true);
    expect(snap.roster).toHaveLength(1);
    expect(snap.roster[0]?.isHost).toBe(true);
  });

  it('lets a peer join with just a nickname and both see the roster', async () => {
    const host = await RoomSession.host({
      nickname: 'host',
      relayUrl: relay.url,
      argonParams: MIN_ARGON_PARAMS,
    });
    const hostBox = track(host);

    const peer = await RoomSession.join({ nickname: 'bob', relayUrl: relay.url });
    const peerBox = track(peer);
    await settle();

    expect(peerBox.last.phase).toBe('in-room');
    expect(peerBox.last.roster.map((e) => e.nickname).sort()).toEqual(['bob', 'host']);
    expect(hostBox.last.roster.map((e) => e.nickname).sort()).toEqual(['bob', 'host']);
  });

  it('rejects joining when nobody is hosting the room yet', async () => {
    await expect(
      RoomSession.join({ nickname: 'nobody-home', relayUrl: relay.url }),
    ).rejects.toThrow(/no_such_room|rejected/i);
  });

  describe('enter() - the single "Entrar" button', () => {
    it('becomes the host when nobody is hosting yet', async () => {
      const session = await RoomSession.enter({
        nickname: 'first-one-in',
        relayUrl: relay.url,
        argonParams: MIN_ARGON_PARAMS,
      });
      track(session);
      const snap = session.snapshot();

      expect(snap.phase).toBe('hosting');
      expect(snap.isHost).toBe(true);
    });

    it('joins instead when someone is already hosting', async () => {
      const host = await RoomSession.host({
        nickname: 'host',
        relayUrl: relay.url,
        argonParams: MIN_ARGON_PARAMS,
      });
      const hostBox = track(host);

      const second = await RoomSession.enter({ nickname: 'second-one-in', relayUrl: relay.url });
      const secondBox = track(second);
      await settle();

      expect(secondBox.last.phase).toBe('in-room');
      expect(secondBox.last.isHost).toBe(false);
      expect(hostBox.last.roster).toHaveLength(2);
    });

    it('falls back to joining if it loses the race to host (room_exists)', async () => {
      // simulate two enter() calls landing at nearly the same instant: the
      // first host() call below wins for real, then a fresh enter() should
      // see room_exists on its own host attempt and fall back to join()
      // rather than surfacing an error to the UI.
      const winner = await RoomSession.host({
        nickname: 'winner',
        relayUrl: relay.url,
        argonParams: MIN_ARGON_PARAMS,
      });
      track(winner);

      const loser = RoomSession.begin();
      track(loser);
      await loser.enter({ nickname: 'loser', relayUrl: relay.url });
      await settle();

      expect(loser.snapshot().phase).toBe('in-room');
      expect(loser.snapshot().isHost).toBe(false);
    });
  });

  it('does not leave a dangling host link if leave() races the initial connect', async () => {
    const session = RoomSession.begin();
    track(session);
    // leave() fires while host()'s relay connect is still in flight - it must
    // not resolve into a live 'hosting' session, and must not leak the link.
    const hostPromise = session.host({
      nickname: 'race',
      relayUrl: relay.url,
      argonParams: MIN_ARGON_PARAMS,
    });
    await session.leave();
    await hostPromise;

    const snap = session.snapshot();
    expect(snap.phase).toBe('left');
    expect(snap.isHost).toBe(false);

    // give the relay a moment to process the host socket's close, then prove
    // the room was actually torn down there too (not just locally) - the
    // fixed room id is free again for the next join attempt to fail against.
    await settle();
    await expect(
      RoomSession.join({ nickname: 'nobody-home', relayUrl: relay.url }),
    ).rejects.toThrow(/no_such_room/i);
  });

  it('drops the peer from the host roster on leave', async () => {
    const host = await RoomSession.host({
      nickname: 'host',
      relayUrl: relay.url,
      argonParams: MIN_ARGON_PARAMS,
    });
    const hostBox = track(host);
    const peer = await RoomSession.join({ nickname: 'carol', relayUrl: relay.url });
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
      relayUrl: oneOffRelay.url,
      argonParams: MIN_ARGON_PARAMS,
    });
    track(host);
    const peer = await RoomSession.join({ nickname: 'dana', relayUrl: oneOffRelay.url });
    const peerBox = track(peer);
    await settle();

    await oneOffRelay.close();
    await settle();

    expect(peerBox.last.phase).toBe('left');
    expect(peerBox.last.notice).toBeTruthy();
  });
});
