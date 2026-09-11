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

  // `ideal` so a source that can't do 60fps/1080p (a smaller window, or a
  // display that maxes out lower) still gets picked up instead of rejected -
  // the governor's top rung (1080p60, src/main/sfu/governor.ts) already
  // assumes the encoder settles for whatever the source can actually give.
  const videoConstraints: MediaTrackConstraints = {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 60, max: 60 },
  };

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
      audio: true,
    });
  } catch {
    // some setups reject the combined request; fall back to video only
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
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
