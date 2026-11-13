// Messages between the main thread and the video preview worker.

/**
 * Layout of the shared clock (Float64Array over a SharedArrayBuffer). The main
 * thread writes it every animation frame; the worker reads it without any
 * message traffic. Without cross-origin isolation the same values arrive by
 * postMessage instead.
 */
export const CLOCK_TIME = 0;
export const CLOCK_PLAYING = 1;
export const CLOCK_LENGTH = 2;

export type VideoStats = {
  /** Frames decoded and drawn since the file was opened. */
  drawn: number;
  /** Frames decoded but skipped because playback had moved past them. */
  dropped: number;
  /** VideoSamples currently alive (not yet closed): 1 while playing (the next frame), 0 when paused. */
  open: number;
  /** Times the decoder was restarted for a seek or a jump over a cut. */
  seeks: number;
  /** Duration of the most recent seek, decode-from-keyframe included. */
  lastSeekMs: number;
};

export type ToVideoWorker =
  | { type: 'open'; file: File; canvas: OffscreenCanvas; clock: SharedArrayBuffer | null }
  | { type: 'resize'; width: number; height: number }
  /** Fallback clock when SharedArrayBuffer isn't available. */
  | { type: 'clock'; time: number; playing: boolean };

export type FromVideoWorker =
  | { type: 'ready'; width: number; height: number; codec: string }
  | { type: 'unavailable'; reason: string }
  | { type: 'stats'; stats: VideoStats }
  | { type: 'error'; message: string };
