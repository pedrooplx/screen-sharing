/**
 * Main-process IPC handlers. Holds the single active RoomSession and pushes
 * every snapshot to the renderer. All network / crypto work happens here, never
 * in the renderer.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import log from 'electron-log/main.js';
import { RoomSession } from './room-session.js';
import { listSources, setPendingSource } from './capture.js';
import {
  type CaptureSource,
  IPC,
  type HostRoomRequest,
  type IpcResult,
  type JoinRoomRequest,
  type MediaBody,
  type SessionSnapshot,
} from '../../shared/ipc.js';
import {
  hostRoomRequestSchema,
  joinRoomRequestSchema,
  mediaBodySchema,
} from '../../shared/ipc-schema.js';

let session: RoomSession | null = null;

function idleSnapshot(): SessionSnapshot {
  return {
    phase: 'idle',
    isHost: false,
    selfPeerId: '',
    nickname: '',
    epoch: 0,
    code: null,
    roster: [],
    streams: [],
    maxRecommendedSubscriptions: 2,
    notice: null,
  };
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const push = (snapshot: SessionSnapshot) => {
    getWindow()?.webContents.send(IPC.onUpdate, snapshot);
  };
  const pushMedia = (body: MediaBody) => {
    getWindow()?.webContents.send(IPC.onMedia, body);
  };

  const attach = (s: RoomSession) => {
    session = s;
    s.on('update', push);
    s.on('media', pushMedia);
    push(s.snapshot());
  };

  const teardown = async () => {
    if (session) {
      const s = session;
      s.removeAllListeners();
      session = null;
      await s.leave().catch(() => {});
    }
  };

  /**
   * Clean up exactly `s` (a specific session this handler created), without
   * disturbing whatever `session` points to now. host()/join() can take up to
   * ~75s (relay cold start, §18.4 in DESIGN.md); if a later IPC call already
   * superseded `s` via teardown() in the meantime, `session` is a DIFFERENT,
   * newer RoomSession by the time this handler's `await s.host()/.join()`
   * finally settles - naively calling `teardown()` again here would tear down
   * that unrelated, currently-active room instead. `s` itself still needs
   * cleanup regardless (it may hold a real relay link / SignalingServer).
   */
  const discard = async (s: RoomSession) => {
    s.removeAllListeners();
    if (session === s) session = null;
    await s.leave().catch(() => {});
  };

  ipcMain.handle(
    IPC.hostRoom,
    async (_e, raw: HostRoomRequest): Promise<IpcResult<SessionSnapshot>> => {
      const parsed = hostRoomRequestSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'pedido inválido' };
      await teardown();
      // begin() + attach() before host() runs, so the renderer actually sees
      // 'connecting'/'waking' while a sleeping relay wakes up (~30-50s).
      const s = RoomSession.begin();
      attach(s);
      try {
        await s.host({ nickname: parsed.data.nickname, password: parsed.data.password });
        return { ok: true, value: s.snapshot() };
      } catch (err) {
        log.error('hostRoom failed', err);
        await discard(s);
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    IPC.joinRoom,
    async (_e, raw: JoinRoomRequest): Promise<IpcResult<SessionSnapshot>> => {
      const parsed = joinRoomRequestSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'pedido inválido' };
      await teardown();
      const s = RoomSession.begin();
      attach(s);
      try {
        await s.join({
          nickname: parsed.data.nickname,
          password: parsed.data.password,
          code: parsed.data.code,
        });
        return { ok: true, value: s.snapshot() };
      } catch (err) {
        log.error('joinRoom failed', err);
        await discard(s);
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(IPC.leaveRoom, async (): Promise<IpcResult<SessionSnapshot>> => {
    await teardown();
    const snap = idleSnapshot();
    push(snap);
    return { ok: true, value: snap };
  });

  ipcMain.handle(IPC.getSnapshot, (): SessionSnapshot => {
    return session?.snapshot() ?? idleSnapshot();
  });

  ipcMain.handle(IPC.listSources, async (): Promise<CaptureSource[]> => {
    try {
      return await listSources();
    } catch (err) {
      log.error('listSources failed', err);
      return [];
    }
  });

  ipcMain.handle(
    IPC.setSource,
    (_e, id: unknown): IpcResult<null> => {
      if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
        return { ok: false, error: 'id inválido' };
      }
      setPendingSource(id);
      return { ok: true, value: null };
    },
  );

  ipcMain.on(IPC.sendMedia, (_e, raw: unknown) => {
    const parsed = mediaBodySchema.safeParse(raw);
    if (!parsed.success) {
      log.warn('sendMedia: rejected malformed body');
      return;
    }
    void session?.sendMedia(parsed.data).catch((err) => {
      log.error('sendMedia failed', err);
    });
  });
}

export async function shutdownSession(): Promise<void> {
  if (session) {
    await session.leave().catch(() => {});
    session = null;
  }
}
