/**
 * Local screen/window capture in the renderer. This is preview-only in
 * checkpoint 3.2 - the stream is not published anywhere yet (that is 3.3).
 */

import type { CaptureSource } from '../../shared/ipc.js';

export interface LocalCapture {
  readonly stream: MediaStream;
  readonly source: CaptureSource;
  readonly hasAudio: boolean;
}

export async function startCapture(source: CaptureSource): Promise<LocalCapture> {
  const res = await window.erros.setCaptureSource(source.id);
  if (!res.ok) throw new Error(res.error);

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
  } catch {
    // some setups reject the combined request; fall back to video only
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
  }

  return {
    stream,
    source,
    hasAudio: stream.getAudioTracks().length > 0,
  };
}

export function stopCapture(capture: LocalCapture | null): void {
  capture?.stream.getTracks().forEach((track) => track.stop());
}
