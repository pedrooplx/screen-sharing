/**
 * Screen / window capture wiring for the main process (docs/DESIGN.md section
 * 17.3 step 2).
 *
 * The renderer drives the choice: it lists sources via IPC, shows its own
 * picker, then calls `setPendingSource(id)` and finally
 * `navigator.mediaDevices.getDisplayMedia()`. That last call fires
 * `setDisplayMediaRequestHandler` here, which resolves it with the chosen
 * source plus system audio (`audio: 'loopback'` — Windows WASAPI loopback,
 * Electron >= 30).
 *
 * Known limitation (README "Limitações conhecidas" #9): loopback audio is the
 * whole system, even when a single window is captured.
 */

import { desktopCapturer, session } from 'electron';
import type { CaptureSource } from '../../shared/ipc.js';

let pendingSourceId: string | null = null;

export function setPendingSource(id: string): void {
  pendingSourceId = id;
}

export async function listSources(): Promise<CaptureSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  });
  return sources
    .filter((s) => !s.thumbnail.isEmpty())
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? ('screen' as const) : ('window' as const),
      thumbnail: s.thumbnail.toDataURL(),
    }));
}

/** Install the display-media handler on the default session. Idempotent. */
export function registerCaptureHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
        });
        const chosen =
          sources.find((s) => s.id === pendingSourceId) ?? sources[0];
        if (!chosen) {
          // deny: nothing to capture
          callback({});
          return;
        }
        callback({ video: chosen, audio: 'loopback' });
      } catch {
        callback({});
      } finally {
        pendingSourceId = null;
      }
    },
    // our renderer provides the picker UI; don't pop the OS one
    { useSystemPicker: false },
  );
}
