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
    codeStatus: null,
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
      session.removeAllListeners();
      await session.leave().catch(() => {});
      session = null;
    }
  };

  ipcMain.handle(
    IPC.hostRoom,
    async (_e, raw: HostRoomRequest): Promise<IpcResult<SessionSnapshot>> => {
      const parsed = hostRoomRequestSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'pedido inválido' };
      try {
        await teardown();
        const s = await RoomSession.host({
          nickname: parsed.data.nickname,
          password: parsed.data.password,
          ...(parsed.data.port ? { port: parsed.data.port } : {}),
        });
        attach(s);
        return { ok: true, value: s.snapshot() };
      } catch (err) {
        log.error('hostRoom failed', err);
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    IPC.joinRoom,
    async (_e, raw: JoinRoomRequest): Promise<IpcResult<SessionSnapshot>> => {
      const parsed = joinRoomRequestSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'pedido inválido' };
      try {
        await teardown();
        const s = await RoomSession.join({
          nickname: parsed.data.nickname,
          password: parsed.data.password,
          code: parsed.data.code,
          ...(parsed.data.inboundPort
            ? { inboundPort: parsed.data.inboundPort }
            : {}),
        });
        attach(s);
        return { ok: true, value: s.snapshot() };
      } catch (err) {
        log.error('joinRoom failed', err);
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
