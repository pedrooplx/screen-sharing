/**
 * Dev-only stub of the `window.erros` bridge, so the renderer can be opened in
 * a plain browser (no Electron) for visual work. Activated by `?mock` in the
 * URL. Never bundled into the Electron build path (guarded in main.tsx).
 */

import type { ErrosApi, SessionSnapshot } from '../../shared/ipc.js';

const listeners = new Set<(s: SessionSnapshot) => void>();

let state: SessionSnapshot = {
  phase: 'idle',
  isHost: false,
  selfPeerId: '',
  nickname: '',
  epoch: 0,
  roster: [],
  streams: [],
  maxRecommendedSubscriptions: 2,
  notice: null,
};

function set(next: Partial<SessionSnapshot>): void {
  state = { ...state, ...next };
  for (const cb of listeners) cb(state);
}

export function installMock(): void {
  const api: ErrosApi = {
    async enterRoom({ nickname }) {
      // always mocks as "became the host" (richer preview: other
      // participants + a stream) - this stub never talks to a real relay, so
      // there's no "someone's already hosting" case to simulate here.
      set({ phase: 'connecting', nickname });
      await new Promise((r) => setTimeout(r, 700));
      set({
        phase: 'hosting',
        isHost: true,
        selfPeerId: 'p_host',
        epoch: 0,
        notice: null,
        roster: [
          rosterEntry('p_host', nickname, 0, true, true),
          rosterEntry('p_a', 'ana', 1, false, true),
          rosterEntry('p_b', 'bruno', 2, false, false),
        ],
        streams: [
          { streamId: 's_ana', ownerPeerId: 'p_a', video: true, audio: true },
        ],
      });
      return { ok: true, value: state };
    },
    async leaveRoom() {
      set({
        phase: 'idle',
        isHost: false,
        roster: [],
        notice: null,
      });
      return { ok: true, value: state };
    },
    async getSnapshot() {
      return state;
    },
    async listSources() {
      await new Promise((r) => setTimeout(r, 400));
      return [
        mockSource('screen:0:0', 'Tela inteira', 'screen', '#1f6feb'),
        mockSource('window:12:0', 'Google Chrome — erros-share', 'window', '#238636'),
        mockSource('window:34:0', 'Visual Studio Code', 'window', '#8957e5'),
      ];
    },
    async setCaptureSource() {
      return { ok: true, value: null };
    },
    async setFloating() {
      // no real OS window to resize in the plain-browser preview
      return { ok: true, value: null };
    },
    sendMedia() {
      /* no SFU in mock mode */
    },
    onMedia() {
      return () => {};
    },
    onUpdate(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  (window as unknown as { erros: ErrosApi }).erros = api;
}

function mockSource(
  id: string,
  name: string,
  kind: 'screen' | 'window',
  color: string,
): { id: string; name: string; kind: 'screen' | 'window'; thumbnail: string } {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="${color}"/></svg>`;
  return { id, name, kind, thumbnail: `data:image/svg+xml;base64,${btoa(svg)}` };
}

function rosterEntry(
  peerId: string,
  nickname: string,
  joinSeq: number,
  isHost: boolean,
  inboundVerified: boolean,
): SessionSnapshot['roster'][number] {
  return {
    peerId,
    nickname,
    joinSeq,
    isHost,
    inboundVerified,
    inboundEndpoint: inboundVerified
      ? { address: '10.0.0.' + joinSeq, port: 47822 }
      : null,
    publishing: null,
  };
}
