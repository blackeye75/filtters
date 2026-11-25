/**
 * Turns the engine's canvas into a MediaStreamTrack for a web WebRTC call.
 *
 * captureStream(0) + requestFrame() emits exactly one frame per processed camera frame, at the moment
 * it is rendered (no extra buffering, no duplicated or skipped frames). Falls back to a fixed rate where
 * requestFrame is missing.
 *
 * Production upgrade for Chromium: run the engine in a Worker with MediaStreamTrackProcessor ->
 * OffscreenCanvas -> MediaStreamTrackGenerator, which keeps all per-frame work off the main thread.
 */
export interface FilteredTrack {
  stream: MediaStream;
  track: MediaStreamTrack;
  /** Call after each engine.process(). */
  pushFrame(): void;
}

export function createFilteredTrack(canvas: HTMLCanvasElement, fps = 30): FilteredTrack {
  const manual = canvas.captureStream(0);
  const track = manual.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  if (typeof track.requestFrame === "function") {
    return { stream: manual, track, pushFrame: () => track.requestFrame!() };
  }
  track.stop();
  const timed = canvas.captureStream(fps);
  return { stream: timed, track: timed.getVideoTracks()[0], pushFrame: () => {} };
}
