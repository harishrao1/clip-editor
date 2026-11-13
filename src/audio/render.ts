export type ClipSettings = {
  gain: number;
  fadeIn: number;
  fadeOut: number;
};

/** A stretch of `buffer` from `start` to `end` (seconds) to place in the output. */
export type Piece = { buffer: AudioBuffer; start: number; end: number };

/** Short ramp at every join between pieces; without it each cut clicks. */
const JOIN_FADE = 0.004;

/**
 * Renders pieces back to back, faster than real time, with micro-fades at the
 * joins and the clip's gain and fade in/out applied over the whole result.
 */
export async function renderClip(pieces: Piece[], s: ClipSettings): Promise<AudioBuffer> {
  const sampleRate = pieces[0].buffer.sampleRate;
  const channels = Math.max(...pieces.map((p) => p.buffer.numberOfChannels));
  const duration = pieces.reduce((sum, p) => sum + (p.end - p.start), 0);
  const ctx = new OfflineAudioContext(channels, Math.max(1, Math.round(duration * sampleRate)), sampleRate);

  const master = ctx.createGain();
  master.connect(ctx.destination);
  // Fades can't overlap past the midpoint of the clip.
  const fadeIn = Math.min(s.fadeIn, duration / 2);
  const fadeOut = Math.min(s.fadeOut, duration / 2);
  const g = master.gain;
  g.setValueAtTime(fadeIn > 0 ? 0 : s.gain, 0);
  if (fadeIn > 0) g.linearRampToValueAtTime(s.gain, fadeIn);
  if (fadeOut > 0) {
    g.setValueAtTime(s.gain, duration - fadeOut);
    g.linearRampToValueAtTime(0, duration);
  }

  let at = 0;
  pieces.forEach((p, i) => {
    const len = p.end - p.start;
    const src = ctx.createBufferSource();
    src.buffer = p.buffer;
    const join = ctx.createGain();
    src.connect(join).connect(master);
    const ramp = Math.min(JOIN_FADE, len / 4);
    // The clip's own start and end are shaped by fadeIn/fadeOut, so only inner joins get ramps.
    if (i > 0) {
      join.gain.setValueAtTime(0, at);
      join.gain.linearRampToValueAtTime(1, at + ramp);
    }
    if (i < pieces.length - 1) {
      join.gain.setValueAtTime(1, at + len - ramp);
      join.gain.linearRampToValueAtTime(0, at + len);
    }
    src.start(at, p.start, len);
    at += len;
  });

  return ctx.startRendering();
}

/** 16-bit PCM WAV, channels interleaved. */
export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const dataSize = frames * channels * 2;
  const view = new DataView(new ArrayBuffer(44 + dataSize));

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}
