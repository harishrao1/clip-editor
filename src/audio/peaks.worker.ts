// Reduces raw PCM to min/max pairs and mean-square energy per bucket so the
// timeline never touches millions of samples per frame. Runs off the main thread.

export type PeakRequest = { channels: Float32Array[]; samplesPerPeak: number };

self.onmessage = (e: MessageEvent<PeakRequest>) => {
  const { channels, samplesPerPeak } = e.data;
  const length = channels[0].length;
  const count = Math.ceil(length / samplesPerPeak);
  const peaks = new Float32Array(count * 2);
  const energy = new Float32Array(count);
  const scale = 1 / channels.length;

  for (let p = 0; p < count; p++) {
    let min = 1;
    let max = -1;
    let sumSq = 0;
    const start = p * samplesPerPeak;
    const end = Math.min(length, start + samplesPerPeak);
    for (let i = start; i < end; i++) {
      let s = 0;
      for (let c = 0; c < channels.length; c++) s += channels[c][i];
      s *= scale;
      if (s < min) min = s;
      if (s > max) max = s;
      sumSq += s * s;
    }
    peaks[p * 2] = min;
    peaks[p * 2 + 1] = max;
    energy[p] = sumSq / (end - start);
  }

  (self as unknown as Worker).postMessage({ peaks, energy }, [peaks.buffer, energy.buffer]);
};
