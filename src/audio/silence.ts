/**
 * Silence detection over per-bucket energy (mean square of the mono mixdown,
 * one value per `samplesPerPeak` frames). Works on whatever part of the file
 * has been analysed so far, so results grow while a long file is ingested.
 */

export type Range = { start: number; end: number };

export type SilenceOptions = {
  /** Windows quieter than this (dBFS RMS) count as silent. */
  thresholdDb: number;
  /** Only gaps at least this long (seconds) are reported. */
  minDuration: number;
  /** Seconds left untouched on each side of a gap so speech isn't clipped. */
  padding: number;
};

const WINDOW_SEC = 0.02;
/** Non-silent blips shorter than this (a click, a breath) don't split a silence. */
const BRIDGE_SEC = 0.12;
const FLOOR_DB = -100;

export type Levels = { levels: Float32Array; windowSec: number };

/**
 * RMS level in dBFS for each ~20 ms window of the analysed part. This is the
 * expensive step; compute it once per data change and reuse it for detection
 * and threshold suggestion, so moving a slider only re-runs the cheap scan.
 */
export function windowLevels(energy: Float32Array, bucketSec: number, analysedBuckets: number): Levels {
  const per = Math.max(1, Math.round(WINDOW_SEC / bucketSec));
  const count = Math.floor(Math.min(analysedBuckets, energy.length) / per);
  const levels = new Float32Array(count);
  for (let w = 0; w < count; w++) {
    let sum = 0;
    for (let b = w * per; b < (w + 1) * per; b++) sum += energy[b];
    const ms = sum / per;
    levels[w] = ms > 0 ? Math.max(FLOOR_DB, 10 * Math.log10(ms)) : FLOOR_DB;
  }
  return { levels, windowSec: per * bucketSec };
}

export function detectSilences({ levels, windowSec }: Levels, opts: SilenceOptions): Range[] {
  const runs: Range[] = [];
  let runStart = -1;
  for (let w = 0; w <= levels.length; w++) {
    const silent = w < levels.length && levels[w] < opts.thresholdDb;
    if (silent && runStart < 0) runStart = w;
    if (!silent && runStart >= 0) {
      const run = { start: runStart * windowSec, end: w * windowSec };
      const prev = runs[runs.length - 1];
      if (prev && run.start - prev.end < BRIDGE_SEC) prev.end = run.end;
      else runs.push(run);
      runStart = -1;
    }
  }
  const out: Range[] = [];
  for (const r of runs) {
    if (r.end - r.start < opts.minDuration) continue;
    const start = r.start + opts.padding;
    const end = r.end - opts.padding;
    if (end - start > 0.05) out.push({ start, end });
  }
  return out;
}

/**
 * A threshold between the recording's noise floor and its speech level, so
 * detection works on a noisy phone recording as well as a clean studio one.
 */
export function suggestThreshold({ levels }: Levels): number {
  if (levels.length < 50) return -45;
  // Percentiles from an evenly spaced subsample keep this fast on multi-hour files.
  const step = Math.max(1, Math.floor(levels.length / 20000));
  const sample: number[] = [];
  for (let i = 0; i < levels.length; i += step) sample.push(levels[i]);
  sample.sort((a, b) => a - b);
  const at = (p: number) => sample[Math.min(sample.length - 1, Math.floor(p * sample.length))];
  const noise = at(0.1);
  const speech = at(0.9);
  const threshold = noise + Math.max(6, (speech - noise) * 0.3);
  return Math.round(Math.min(-20, Math.max(-70, threshold)));
}

/** Clip-range intersection of each range, dropping ones that fall outside. */
export function clampRanges(ranges: Range[], within: Range): Range[] {
  const out: Range[] = [];
  for (const r of ranges) {
    const start = Math.max(r.start, within.start);
    const end = Math.min(r.end, within.end);
    if (end - start > 0.01) out.push({ start, end });
  }
  return out;
}

/** The parts of `within` not covered by `cuts`, in order. */
export function keptSegments(within: Range, cuts: Range[]): Range[] {
  const sorted = clampRanges(cuts, within).sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  let cursor = within.start;
  for (const c of sorted) {
    if (c.start > cursor + 0.001) out.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (within.end > cursor + 0.001) out.push({ start: cursor, end: within.end });
  return out;
}

export const totalLength = (ranges: Range[]) => ranges.reduce((sum, r) => sum + (r.end - r.start), 0);

export const overlaps = (a: Range, b: Range) => a.start < b.end && b.start < a.end;
