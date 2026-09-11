import type { ErrosApi } from '../../shared/ipc.js';

// Not yet in TypeScript's bundled DOM lib. Declared narrowly to the surface
// this app actually calls - see StreamsPanel.tsx's maximize(). Optional
// because it must still be feature-detected at runtime (older Chromium, or
// an Electron build that hasn't wired it up, simply won't have it).
interface DocumentPictureInPicture extends EventTarget {
  readonly window: Window | null;
  requestWindow(options?: {
    width?: number;
    height?: number;
    disallowReturnToOpener?: boolean;
    preferInitialWindowPlacement?: boolean;
  }): Promise<Window>;
}

declare global {
  interface Window {
    erros: ErrosApi;
    readonly documentPictureInPicture?: DocumentPictureInPicture;
  }
}

export {};
