/**
 * Video preview worker. Demuxes and decodes the video track with WebCodecs
 * (via Mediabunny) and draws frames into an OffscreenCanvas it owns, so
 * decoding and drawing never touch the main thread.
 *
 * Decoded frames (VideoSamples) live in a small, fixed pool of decoder/GPU
 * buffers outside the JS garbage collector. Holding on to them doesn't just
 * waste memory: once the pool is exhausted the decoder stops producing frames
 * and playback deadlocks. So a frame is drawn as soon as it becomes current and
 * closed immediately after; the canvas keeps the pixels, and only the frame's
 * time span is remembered. At most one decoded frame (the next one) is held.
 */
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type VideoSample } from 'mediabunny';
import { CLOCK_PLAYING, CLOCK_TIME, type FromVideoWorker, type ToVideoWorker, type VideoStats } from './protocol';

const post = (msg: FromVideoWorker) => (self as unknown as Worker).postMessage(msg);

/**
 * The clock counts as having jumped (a seek, or skipping a cut) when it moves
 * this far from where continuous playback would have put it.
 */
const DISCONTINUITY_SEC = 0.25;
/** If decoding ever falls this far behind continuous playback, skip ahead instead of catching up. */
const MAX_LAG_SEC = 3;
/** Catching up decodes frames without drawing them; draw at least this often. */
const ADVANCE_BUDGET_MS = 40;

type Span = { start: number; end: number };

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let sink: VideoSampleSink | null = null;
let clock: Float64Array | null = null;
let fallback = { time: 0, playing: false };

/** Time span of the frame currently on the canvas (the frame itself is already closed). */
let shown: Span | null = null;
/** The one decoded frame held: next in line during playback. */
let next: VideoSample | null = null;
let iterator: AsyncGenerator<VideoSample, void, unknown> | null = null;
let lastPausedRequest = Number.NaN;
/** Clock reading from the previous playing tick, to tell a jump from ordinary progress. */
let previous: { time: number; wall: number } | null = null;

const stats: VideoStats = { drawn: 0, dropped: 0, open: 0, seeks: 0, lastSeekMs: 0 };

const own = (s: VideoSample | null | undefined) => {
  if (s) stats.open++;
  return s ?? null;
};
const release = (s: VideoSample | null) => {
  if (!s) return;
  s.close();
  stats.open--;
};

self.onmessage = (e: MessageEvent<ToVideoWorker>) => {
  const msg = e.data;
  if (msg.type === 'open') void open(msg.file, msg.canvas, msg.clock);
  else if (msg.type === 'resize' && canvas) {
    // Resizing clears the canvas; forget what was shown so the frame is fetched and drawn again.
    canvas.width = msg.width;
    canvas.height = msg.height;
    shown = null;
    lastPausedRequest = Number.NaN;
  } else if (msg.type === 'clock') fallback = { time: msg.time, playing: msg.playing };
};

async function open(file: File, target: OffscreenCanvas, sharedClock: SharedArrayBuffer | null) {
  canvas = target;
  ctx = target.getContext('2d');
  clock = sharedClock ? new Float64Array(sharedClock) : null;
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return post({ type: 'unavailable', reason: 'This file has no video track.' });
    const codec = (await track.getCodec()) ?? 'unknown';
    if (!(await track.canDecode())) {
      return post({ type: 'unavailable', reason: `This browser can't decode ${codec} video.` });
    }
    sink = new VideoSampleSink(track);
    post({ type: 'ready', width: track.displayWidth, height: track.displayHeight, codec });
    setInterval(() => post({ type: 'stats', stats: { ...stats } }), 500);
    await loop();
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

function readClock(): { time: number; playing: boolean } {
  if (!clock) return fallback;
  return { time: clock[CLOCK_TIME], playing: clock[CLOCK_PLAYING] === 1 };
}

/**
 * Wait for the next display frame, but never longer than ~30 fps worth of time:
 * rAF is suspended entirely while the page is hidden, and the loop must not
 * freeze with a frame held open. While hidden the clock stops moving, so these
 * wake-ups find nothing to do.
 */
const nextTick = () =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 34);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      });
    }
  });

async function loop() {
  for (;;) {
    const { time, playing } = readClock();
    if (playing) await stepPlaying(time);
    else await stepPaused(time);
    await nextTick();
  }
}

const covers = (span: Span | null, time: number) => span !== null && time >= span.start && time < span.end;

/** Paused or scrubbing: show the exact frame for `time`. The loop awaits each decode, so rapid scrubs coalesce. */
async function stepPaused(time: number) {
  previous = null;
  if (iterator) await stopIterator(); // hold nothing while nothing plays
  if (covers(shown, time)) return;
  if (time === lastPausedRequest) return; // e.g. past the last frame: getSample already gave its best answer
  lastPausedRequest = time;
  const started = performance.now();
  const sample = own(await sink!.getSample(time));
  if (!sample) return;
  present(sample);
  stats.seeks++;
  stats.lastSeekMs = Math.round(performance.now() - started);
}

/** Playing: walk forward through decoded frames, restarting the decoder only when the clock jumps. */
async function stepPlaying(time: number) {
  lastPausedRequest = Number.NaN;
  const wall = performance.now() / 1000;
  // Judge jumps by the clock, not by the decoder: a decoder that is merely behind
  // must catch up by dropping frames, not restart from a keyframe (which only puts it further behind).
  const clockJumped = !previous || Math.abs(time - (previous.time + (wall - previous.wall))) > DISCONTINUITY_SEC;
  // The reference only follows a well-behaved clock. If the main thread stalls (GC, a
  // long task) the clock freezes, then resumes where it should be: measured against
  // this reference that is not a jump, so it doesn't cost a restart from a keyframe.
  if (!clockJumped) previous = { time, wall };
  const frontier = next?.timestamp ?? shown?.end ?? 0;
  const outsideWindow = !shown || time < shown.start - 0.05 || time > frontier + 0.05;

  if (!iterator || (clockJumped && outsideWindow) || time > frontier + MAX_LAG_SEC) {
    const started = performance.now();
    previous = { time, wall };
    await stopIterator();
    iterator = sink!.samples(time);
    const first = own(await pull());
    if (first) present(first);
    next = own(await pull());
    stats.seeks++;
    stats.lastSeekMs = Math.round(performance.now() - started);
    return;
  }

  // Advance to the newest frame whose timestamp has been reached. Frames passed
  // over are closed without drawing; if catching up takes too long, draw what we have.
  const budgetEnd = performance.now() + ADVANCE_BUDGET_MS;
  while (next && next.timestamp <= time) {
    const candidate = next;
    next = own(await pull());
    if (next && next.timestamp <= time && performance.now() < budgetEnd) {
      release(candidate);
      stats.dropped++;
      continue;
    }
    present(candidate);
    break;
  }
}

/** Draw a frame, remember its time span, and close it straight away. */
function present(sample: VideoSample) {
  shown = { start: sample.timestamp, end: sample.timestamp + sample.duration };
  if (ctx && canvas) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    sample.drawWithFit(ctx, { fit: 'contain' });
    stats.drawn++;
  }
  release(sample);
}

async function pull(): Promise<VideoSample | null> {
  const result = await iterator!.next();
  return result.done ? null : result.value;
}

async function stopIterator() {
  release(next);
  next = null;
  // return() lets Mediabunny close any frames it decoded ahead internally.
  await iterator?.return();
  iterator = null;
}
