/**
 * Synthesises a speech-like demo clip (voiced "syllables" grouped into phrases
 * over a soft pad) so the editor can be tried without a file.
 */
export function createSampleBuffer(ctx: BaseAudioContext, seconds = 45): AudioBuffer {
  const sr = ctx.sampleRate;
  const length = Math.round(seconds * sr);
  const buffer = ctx.createBuffer(2, length, sr);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  // Deterministic PRNG so the sample looks the same every time.
  let seed = 1337;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  // Build syllable events: phrases of 4–10 syllables separated by pauses.
  type Syllable = { start: number; dur: number; f0: number; amp: number };
  const syllables: Syllable[] = [];
  let t = 0.6;
  while (t < seconds - 1) {
    const count = 4 + Math.floor(rand() * 7);
    const pitch = 110 + rand() * 90;
    for (let i = 0; i < count && t < seconds - 1; i++) {
      const dur = 0.12 + rand() * 0.28;
      syllables.push({ start: t, dur, f0: pitch * (0.9 + rand() * 0.25), amp: 0.35 + rand() * 0.5 });
      t += dur + 0.03 + rand() * 0.08;
    }
    // Mostly short breaths between phrases, with the occasional long pause to cut.
    t += rand() < 0.35 ? 1.8 + rand() * 1.6 : 0.45 + rand() * 0.9;
  }

  for (const s of syllables) {
    const i0 = Math.round(s.start * sr);
    const i1 = Math.min(length, Math.round((s.start + s.dur) * sr));
    for (let i = i0; i < i1; i++) {
      const local = (i - i0) / sr;
      const env = Math.sin((Math.PI * local) / s.dur) ** 1.5 * s.amp;
      const phase = 2 * Math.PI * s.f0 * local * (1 - 0.1 * local);
      // Harmonics with falling energy roughly approximate a voiced vowel.
      const v =
        Math.sin(phase) * 0.55 +
        Math.sin(phase * 2) * 0.3 +
        Math.sin(phase * 3) * 0.18 +
        Math.sin(phase * 5) * 0.08 +
        (rand() - 0.5) * 0.06;
      left[i] += v * env * 0.6;
      right[i] += v * env * 0.55;
    }
  }

  // Quiet pad underneath.
  for (let i = 0; i < length; i++) {
    const time = i / sr;
    const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.05 * time);
    const pad = (Math.sin(2 * Math.PI * 110 * time) + Math.sin(2 * Math.PI * 164.8 * time) * 0.7) * 0.025 * swell;
    left[i] += pad;
    right[i] += pad * 0.9;
  }
  return buffer;
}
