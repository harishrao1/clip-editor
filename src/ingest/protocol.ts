// Messages between the main thread and the ingest worker.

export type MediaInfo = {
  duration: number;
  /** Rate of the decoded audio, which can differ from the container's declared rate (e.g. HE-AAC). */
  sampleRate: number;
  numberOfChannels: number;
  container: string;
  audioCodec: string;
  video: { codec: string; width: number; height: number } | null;
  /** Total number of [min, max] pairs the peaks array will hold. */
  peakCount: number;
};

export type ToWorker =
  | { type: 'open'; file: File; samplesPerPeak: number }
  | { type: 'readRange'; id: number; start: number; end: number };

export type FromWorker =
  | { type: 'info'; info: MediaInfo; fromCache: boolean }
  /**
   * A run of buckets starting at bucket `offset`: `data` holds [min, max] pairs and
   * `energy` the mean square per bucket. Both are transferred, not copied.
   */
  | { type: 'peaks'; offset: number; data: Float32Array; energy: Float32Array; analysedUntil: number }
  | { type: 'done'; ms: number; fromCache: boolean }
  /** `unsupported` means the container or codec can't be handled here, so the caller may fall back. */
  | { type: 'error'; message: string; unsupported: boolean }
  | { type: 'range'; id: number; channels: Float32Array<ArrayBuffer>[]; sampleRate: number }
  | { type: 'rangeError'; id: number; message: string };
