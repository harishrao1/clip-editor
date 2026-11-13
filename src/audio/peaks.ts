export type PeakData = {
  /** Interleaved [min, max, min, max, ...] of the mono mixdown, one pair per bucket. */
  peaks: Float32Array;
  /** Mean square of the mono mixdown per bucket, for silence detection. */
  energy: Float32Array;
};

export function computePeaks(buffer: AudioBuffer, samplesPerPeak: number): Promise<PeakData> {
  const worker = new Worker(new URL('./peaks.worker.ts', import.meta.url), { type: 'module' });
  // Copies are transferred (zero-copy hand-off) so the AudioBuffer stays usable here.
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) =>
    buffer.getChannelData(c).slice(),
  );

  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<PeakData>) => {
      resolve(e.data);
      worker.terminate();
    };
    worker.onerror = (e) => {
      reject(new Error(e.message || 'Peak worker failed'));
      worker.terminate();
    };
    worker.postMessage(
      { channels, samplesPerPeak },
      channels.map((c) => c.buffer),
    );
  });
}
