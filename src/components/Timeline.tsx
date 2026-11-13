import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react';
import { overlaps, type Range } from '../audio/silence';
import { readColors } from '../theme';
import type { Filmstrip } from '../video/filmstrip';
import { formatTime } from '../time';

export type TimelineHandle = {
  zoomBy: (factor: number) => void;
  fit: () => void;
  zoomToSelection: () => void;
};

type Props = {
  ref?: Ref<TimelineHandle>;
  peaks: Float32Array;
  samplesPerPeak: number;
  sampleRate: number;
  duration: number;
  trimStart: number;
  trimEnd: number;
  getPosition: () => number;
  isPlaying: () => boolean;
  onSeek: (t: number) => void;
  onTrimChange: (start: number, end: number) => void;
  /** Zoom relative to "fit whole file", e.g. 1 = fit, 8 = 8× zoomed in. */
  onZoomChange?: (zoom: number) => void;
  /** Changing this re-reads the canvas colours from CSS. */
  theme: string;
  /** Bumped whenever more of `peaks` has been filled in. */
  peaksVersion: number;
  /** Peaks are valid up to this time; the rest is still being analysed. */
  analysedUntil: number;
  /** Detected silent gaps, shown in the silence lane. */
  silences: Range[];
  /** Ranges removed from the clip. */
  cuts: Range[];
  /** Clicking a block in the silence lane cuts it, or restores it if already cut. */
  onToggleSilence: (range: Range) => void;
  /** Video thumbnails; when present the timeline gets a filmstrip track. */
  filmstrip?: Filmstrip | null;
};

// Layout (CSS px). Ruler, filmstrip (video only), waveform and silence lane on top; overview underneath.
const RULER = 26;
const FILM_H = 46;
const WAVE_H = 162;
const LANE_H = 20;
const GAP = 1;
const MINI_H = 44;

/** Vertical layout of the tracks. The filmstrip row only exists for video files. */
function geometry(hasFilm: boolean) {
  const waveTop = RULER + (hasFilm ? FILM_H : 0);
  const laneTop = waveTop + WAVE_H;
  const mainH = laneTop + LANE_H;
  return { filmTop: RULER, waveTop, laneTop, mainH, miniTop: mainH + GAP, height: mainH + GAP + MINI_H };
}

/** Largest display gain for quiet recordings, so near-silence isn't blown up into noise. */
const MAX_WAVE_GAIN = 6;

const HANDLE_HIT_PX = 9;
const MIN_CLIP = 0.05;
const TICK_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];

const MONO = "'Geist Mono', ui-monospace, Menlo, Consolas, monospace";

// Canvas colours come from CSS custom properties so they follow the theme.
const COLOR_VARS = {
  bg: '--tl-bg',
  ruler: '--tl-ruler',
  rulerLine: '--tl-ruler-line',
  tick: '--tl-tick',
  tickMinor: '--tl-tick-minor',
  label: '--tl-label',
  grid: '--tl-grid',
  center: '--tl-center',
  waveIdle: '--tl-wave-idle',
  wave: '--tl-wave',
  selection: '--tl-selection',
  dim: '--tl-dim',
  handle: '--tl-handle',
  handleGrip: '--tl-handle-grip',
  playhead: '--tl-playhead',
  hover: '--tl-hover',
  bubble: '--tl-bubble',
  bubbleText: '--tl-bubble-text',
  miniBg: '--tl-mini-bg',
  miniWave: '--tl-mini-wave',
  miniWaveSel: '--tl-mini-wave-sel',
  viewport: '--tl-viewport',
  viewportEdge: '--tl-viewport-edge',
  silence: '--tl-silence',
  silenceBlock: '--tl-silence-block',
  cut: '--tl-cut',
  cutLine: '--tl-cut-line',
  cutBlock: '--tl-cut-block',
  laneBg: '--tl-lane-bg',
};
type Colors = Record<keyof typeof COLOR_VARS, string>;

type LaneItem = Range & { cut: boolean };

/** Cuts, plus detected silences that aren't already (partly) cut. */
function laneItems(silences: Range[], cuts: Range[]): LaneItem[] {
  const items: LaneItem[] = cuts.map((c) => ({ ...c, cut: true }));
  for (const s of silences) {
    if (!cuts.some((c) => overlaps(c, s))) items.push({ ...s, cut: false });
  }
  return items;
}

type Drag = 'start' | 'end' | 'playhead' | 'pan' | null;

/**
 * Canvas timeline. The waveform and minimap layers are cached in offscreen
 * canvases and only re-rendered when the view or trim changes; each animation
 * frame just blits them and draws the playhead, hover cursor and viewport box.
 */
export function Timeline(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  // View state lives in refs: it changes on every wheel event and must not re-render React.
  const view = useRef({ pxPerSec: 0, scroll: 0, width: 0 });
  const mainLayer = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const miniLayer = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const mainDirty = useRef(true);
  const miniDirty = useRef(true);
  const drag = useRef<Drag>(null);
  const panGrab = useRef(0);
  const hoverX = useRef<number | null>(null);
  const hoverY = useRef(0);
  const lastZoom = useRef(0);
  const colors = useRef<Colors>(readColors(COLOR_VARS));
  /** Display gain so quiet recordings fill the track, like an editor's waveform zoom. */
  const waveGain = useRef(1);
  const geo = () => geometry(!!propsRef.current.filmstrip);
  const resizeRef = useRef<() => void>(() => {});

  const fitPxPerSec = () => view.current.width / propsRef.current.duration;
  const maxPxPerSec = () => (propsRef.current.sampleRate / propsRef.current.samplesPerPeak) * 4;

  const clampView = () => {
    const v = view.current;
    const { duration } = propsRef.current;
    if (!v.width) return;
    v.pxPerSec = Math.min(maxPxPerSec(), Math.max(fitPxPerSec(), v.pxPerSec));
    v.scroll = Math.min(Math.max(0, v.scroll), Math.max(0, duration - v.width / v.pxPerSec));
    mainDirty.current = true;
    const zoom = v.pxPerSec / fitPxPerSec();
    if (Math.abs(zoom - lastZoom.current) > 0.001) {
      lastZoom.current = zoom;
      propsRef.current.onZoomChange?.(zoom);
    }
  };

  const zoomAround = (factor: number, x: number) => {
    const v = view.current;
    const anchor = v.scroll + x / v.pxPerSec;
    v.pxPerSec *= factor;
    clampView();
    v.scroll = anchor - x / v.pxPerSec; // keep the time under x fixed
    clampView();
  };

  useImperativeHandle(props.ref, () => ({
    zoomBy(factor) {
      const v = view.current;
      // Zoom around the playhead when it's on screen, otherwise around the centre.
      const px = (propsRef.current.getPosition() - v.scroll) * v.pxPerSec;
      zoomAround(factor, px >= 0 && px <= v.width ? px : v.width / 2);
    },
    fit() {
      view.current.pxPerSec = 0;
      view.current.scroll = 0;
      clampView();
    },
    zoomToSelection() {
      const v = view.current;
      const { trimStart, trimEnd } = propsRef.current;
      const len = trimEnd - trimStart;
      v.pxPerSec = v.width / (len * 1.1);
      clampView();
      v.scroll = trimStart - len * 0.05;
      clampView();
    },
  }));

  useEffect(() => {
    mainDirty.current = true;
    miniDirty.current = true;
  }, [props.trimStart, props.trimEnd, props.peaksVersion, props.silences, props.cuts]);

  // Scale the waveform to the recording's loudest peak (capped), recomputed as analysis fills it in.
  useEffect(() => {
    const peaks = props.peaks;
    let loudest = 0;
    for (let i = 0; i < peaks.length; i++) {
      const a = Math.abs(peaks[i]);
      if (a > loudest) loudest = a;
    }
    waveGain.current = loudest > 0 ? Math.min(MAX_WAVE_GAIN, Math.max(1, 0.95 / loudest)) : 1;
  }, [props.peaks, props.peaksVersion]);

  // A filmstrip changes the canvas height and needs redraws as thumbnails arrive.
  useEffect(() => {
    const strip = props.filmstrip;
    resizeRef.current();
    if (!strip) return;
    strip.onUpdate = () => (mainDirty.current = true);
    return () => {
      strip.onUpdate = undefined;
    };
  }, [props.filmstrip]);

  useEffect(() => {
    colors.current = readColors(COLOR_VARS);
    mainDirty.current = true;
    miniDirty.current = true;
  }, [props.theme]);

  // Ruler labels use a web font; redraw once it has loaded.
  useEffect(() => {
    void document.fonts.ready.then(() => (mainDirty.current = true));
  }, []);

  // New file: zoom to fit.
  useEffect(() => {
    view.current.pxPerSec = 0;
    view.current.scroll = 0;
    miniDirty.current = true;
    clampView();
  }, [props.peaks]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current!;
    const resize = (width: number) => {
      if (!width) return;
      const dpr = devicePixelRatio;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(geo().height * dpr);
      // Preserve zoom level across resizes.
      const zoom = view.current.width ? view.current.pxPerSec / fitPxPerSec() : 1;
      view.current.width = width;
      view.current.pxPerSec = fitPxPerSec() * zoom;
      hoverX.current = null;
      miniDirty.current = true;
      clampView();
    };
    // Measure now so the view is valid before the first ResizeObserver callback
    // (which doesn't run while the tab is in the background).
    resize(canvas.getBoundingClientRect().width);
    resizeRef.current = () => resize(canvas.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) => resize(entry.contentRect.width));
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Wheel needs a non-passive listener to preventDefault page scroll / browser zoom.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = view.current;
      if (e.ctrlKey || e.metaKey) {
        zoomAround(Math.exp(-e.deltaY * 0.002), e.clientX - canvas.getBoundingClientRect().left);
      } else {
        v.scroll += (e.deltaX || e.deltaY) / v.pxPerSec;
        clampView();
      }
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    let raf = 0;
    const frame = () => {
      draw();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  function draw() {
    const canvas = canvasRef.current;
    const v = view.current;
    if (!canvas || !v.width) return;
    const p = propsRef.current;
    const C = colors.current;
    const G = geo();
    const pos = p.getPosition();

    // Follow the playhead when it runs off screen.
    if (p.isPlaying() && drag.current === null) {
      const visible = v.width / v.pxPerSec;
      if (pos > v.scroll + visible || pos < v.scroll) {
        v.scroll = pos;
        clampView();
      }
    }

    if (mainDirty.current) {
      renderMain();
      mainDirty.current = false;
    }
    if (miniDirty.current) {
      renderMini();
      miniDirty.current = false;
    }

    const ctx = canvas.getContext('2d')!;
    const dpr = devicePixelRatio;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(mainLayer.current, 0, 0);
    ctx.drawImage(miniLayer.current, 0, Math.round(G.miniTop * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Minimap viewport box + playhead.
    const scale = v.width / p.duration;
    const vx = v.scroll * scale;
    const vw = Math.max(6, (v.width / v.pxPerSec) * scale);
    ctx.fillStyle = C.viewport;
    ctx.strokeStyle = C.viewportEdge;
    ctx.lineWidth = 1;
    ctx.fillRect(vx, G.miniTop + 2, vw, MINI_H - 4);
    ctx.strokeRect(vx + 0.5, G.miniTop + 2.5, vw - 1, MINI_H - 5);
    ctx.fillStyle = C.playhead;
    ctx.fillRect(Math.round(pos * scale), G.miniTop, 1, MINI_H);

    // Hover cursor with a time bubble, or a description of the lane block under the pointer.
    const hx = hoverX.current;
    if (hx !== null && drag.current === null) {
      const item = hoverY.current >= G.laneTop ? laneItemAt(hx) : null;
      if (item) {
        const len = `${(item.end - item.start).toFixed(2)} s`;
        drawBubble(ctx, hx, item.cut ? `Cut ${len} · click to restore` : `Silence ${len} · click to cut`, C.bubble, C.bubbleText);
      } else {
        ctx.fillStyle = C.hover;
        for (let y = RULER; y < G.mainH; y += 6) ctx.fillRect(Math.round(hx), y, 1, 3);
        drawBubble(ctx, hx, formatTime(v.scroll + hx / v.pxPerSec), C.bubble, C.bubbleText);
      }
    }

    // Playhead: a 2px line with a small head in the ruler.
    const x = Math.round((pos - v.scroll) * v.pxPerSec);
    if (x >= -6 && x <= v.width + 6) {
      ctx.fillStyle = C.playhead;
      ctx.fillRect(x - 1, RULER - 8, 2, G.mainH - RULER + 8);
      ctx.fillRect(x - 5, RULER - 12, 10, 5);
    }
  }

  function drawBubble(ctx: CanvasRenderingContext2D, x: number, text: string, bg: string, fg: string) {
    ctx.font = `500 11px ${MONO}`;
    const w = ctx.measureText(text).width + 10;
    const bx = Math.round(Math.min(Math.max(2, x - w / 2), view.current.width - w - 2));
    ctx.fillStyle = bg;
    ctx.fillRect(bx, 4, w, 17);
    ctx.fillStyle = fg;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + 5, 13);
  }

  function prepareLayer(layer: HTMLCanvasElement, height: number) {
    const dpr = devicePixelRatio;
    layer.width = Math.round(view.current.width * dpr);
    layer.height = Math.round(height * dpr);
    const c = layer.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return c;
  }

  /** Diagonal hatching over [x0, x1) for the part of the file not analysed yet. */
  function drawPending(c: CanvasRenderingContext2D, x0: number, top: number, x1: number, height: number) {
    drawHatch(c, x0, top, x1, height, colors.current.tickMinor, 8);
  }

  function drawHatch(c: CanvasRenderingContext2D, x0: number, top: number, x1: number, height: number, color: string, gap: number) {
    c.save();
    c.beginPath();
    c.rect(x0, top, x1 - x0, height);
    c.clip();
    c.strokeStyle = color;
    c.lineWidth = 1;
    c.beginPath();
    // Anchored to absolute x so the pattern doesn't shimmer as regions change.
    for (let x = Math.floor((x0 - height) / gap) * gap; x < x1; x += gap) {
      c.moveTo(x, top + height);
      c.lineTo(x + height, top);
    }
    c.stroke();
    c.restore();
  }

  /** The lane block (cut or detected silence) at canvas x, if any. */
  function laneItemAt(x: number): LaneItem | null {
    const v = view.current;
    const p = propsRef.current;
    const t = v.scroll + x / v.pxPerSec;
    // Blocks are at least 3px wide on screen, so allow that much slack for tiny gaps.
    const slack = 2 / v.pxPerSec;
    return laneItems(p.silences, p.cuts).find((it) => t >= it.start - slack && t <= it.end + slack) ?? null;
  }

  /** Min/max over the peak buckets covering [t0, t1). */
  function columnRange(t0: number, t1: number): [number, number] | null {
    const p = propsRef.current;
    const pps = p.sampleRate / p.samplesPerPeak;
    const count = p.peaks.length / 2;
    const i0 = Math.floor(t0 * pps);
    if (i0 >= count) return null;
    const i1 = Math.min(count, Math.max(i0 + 1, Math.floor(t1 * pps)));
    let min = 1;
    let max = -1;
    for (let i = i0; i < i1; i++) {
      if (p.peaks[i * 2] < min) min = p.peaks[i * 2];
      if (p.peaks[i * 2 + 1] > max) max = p.peaks[i * 2 + 1];
    }
    return [min, max];
  }

  function renderMain() {
    const p = propsRef.current;
    const v = view.current;
    const C = colors.current;
    const G = geo();
    const c = prepareLayer(mainLayer.current, G.mainH);
    const xs = (p.trimStart - v.scroll) * v.pxPerSec;
    const xe = (p.trimEnd - v.scroll) * v.pxPerSec;

    c.fillStyle = C.bg;
    c.fillRect(0, 0, v.width, G.mainH);
    c.fillStyle = C.selection;
    c.fillRect(xs, G.waveTop, xe - xs, G.laneTop - G.waveTop);
    if (p.filmstrip) drawFilmstrip(c, p.filmstrip, G.filmTop);

    // Ruler: pick the smallest step that leaves ~90px between labels, with 4 minor ticks.
    c.fillStyle = C.ruler;
    c.fillRect(0, 0, v.width, RULER);
    c.fillStyle = C.rulerLine;
    c.fillRect(0, RULER - 1, v.width, 1);
    const step = TICK_STEPS.find((s) => s * v.pxPerSec >= 90) ?? TICK_STEPS[TICK_STEPS.length - 1];
    const minor = step / 5;
    c.font = `11px ${MONO}`;
    c.textBaseline = 'middle';
    for (let i = Math.ceil(v.scroll / minor); ; i++) {
      const t = i * minor;
      const x = Math.round((t - v.scroll) * v.pxPerSec);
      if (x > v.width) break;
      const major = i % 5 === 0;
      c.fillStyle = major ? C.tick : C.tickMinor;
      c.fillRect(x, major ? RULER - 9 : RULER - 5, 1, major ? 9 : 5);
      if (major) {
        // Faint grid line through the waveform at major ticks.
        c.fillStyle = C.grid;
        c.fillRect(x, G.waveTop, 1, G.laneTop - G.waveTop);
        c.fillStyle = C.label;
        c.fillText(formatTime(t, step < 1), x + 5, RULER / 2 - 1);
      }
    }

    // Selection bar along the bottom of the ruler.
    c.fillStyle = C.handle;
    c.fillRect(xs, RULER - 3, xe - xs, 3);

    // Waveform: one column per CSS pixel, mirrored around the centre line.
    const mid = G.waveTop + WAVE_H / 2;
    const amp = (WAVE_H / 2 - 8) * waveGain.current;
    const items = laneItems(p.silences, p.cuts);
    const toX = (t: number) => (t - v.scroll) * v.pxPerSec;
    // Detected (kept) silences get a faint tint behind the waveform.
    c.fillStyle = C.silence;
    for (const it of items) {
      if (!it.cut) c.fillRect(toX(it.start), G.waveTop, toX(it.end) - toX(it.start), WAVE_H);
    }
    c.fillStyle = C.center;
    c.fillRect(0, Math.round(mid), v.width, 1);
    let lastFill = '';
    for (let x = 0; x < v.width; x++) {
      const t0 = v.scroll + x / v.pxPerSec;
      if (t0 >= p.analysedUntil) break;
      const range = columnRange(t0, t0 + 1 / v.pxPerSec);
      if (!range) break;
      const [min, max] = range;
      const fill = t0 >= p.trimStart && t0 <= p.trimEnd ? C.wave : C.waveIdle;
      if (fill !== lastFill) c.fillStyle = lastFill = fill;
      const top = Math.max(G.waveTop + 2, mid - max * amp);
      const bottom = Math.min(G.laneTop - 2, mid - min * amp);
      c.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
    // Cuts are hatched over the waveform: still visible, clearly removed.
    for (const it of items) {
      if (!it.cut) continue;
      const x0 = toX(it.start);
      const x1 = toX(it.end);
      if (x1 < 0 || x0 > v.width) continue;
      c.fillStyle = C.cut;
      c.fillRect(x0, RULER, x1 - x0, G.laneTop - RULER);
      drawHatch(c, x0, RULER, x1, G.laneTop - RULER, C.cutLine, 6);
    }

    // Silence lane: one block per gap; filled when cut.
    c.fillStyle = C.laneBg;
    c.fillRect(0, G.laneTop, v.width, LANE_H);
    c.fillStyle = C.rulerLine;
    c.fillRect(0, G.laneTop, v.width, 1);
    if (p.filmstrip) c.fillRect(0, G.waveTop, v.width, 1);
    for (const it of items) {
      const x0 = Math.round(toX(it.start));
      const w = Math.max(3, Math.round(toX(it.end)) - x0);
      if (x0 + w < 0 || x0 > v.width) continue;
      if (it.cut) {
        c.fillStyle = C.cutBlock;
        c.fillRect(x0, G.laneTop + 5, w, LANE_H - 9);
      } else {
        c.fillStyle = C.silence;
        c.fillRect(x0, G.laneTop + 5, w, LANE_H - 9);
        c.strokeStyle = C.silenceBlock;
        c.lineWidth = 1;
        c.strokeRect(x0 + 0.5, G.laneTop + 5.5, w - 1, LANE_H - 10);
      }
    }

    const xa = (p.analysedUntil - v.scroll) * v.pxPerSec;
    if (p.analysedUntil < p.duration && xa < v.width) {
      drawPending(c, Math.max(0, xa), G.waveTop, v.width, G.mainH - G.waveTop);
      const pct = Math.floor((p.analysedUntil / p.duration) * 100);
      c.font = `500 12px ${MONO}`;
      c.fillStyle = C.label;
      c.textBaseline = 'middle';
      c.fillText(`Analysing ${pct}%`, Math.max(0, xa) + 10, mid);
    }

    // Dim outside the selection.
    c.fillStyle = C.dim;
    if (xs > 0) c.fillRect(0, RULER, Math.min(xs, v.width), G.mainH - RULER);
    if (xe < v.width) c.fillRect(Math.max(0, xe), RULER, v.width - Math.max(0, xe), G.mainH - RULER);

    // Handles drawn as brackets: [ at the start, ] at the end, with a grip tab at the top.
    const bottom = G.mainH;
    for (const [rawX, dir] of [[xs, 1], [xe, -1]] as const) {
      if (rawX < -20 || rawX > v.width + 20) continue;
      const hx = Math.round(rawX);
      const lineX = dir > 0 ? hx : hx - 2;
      c.fillStyle = C.handle;
      c.fillRect(lineX, RULER, 2, bottom - RULER);
      c.fillRect(dir > 0 ? hx : hx - 8, bottom - 2, 8, 2);
      const tabX = dir > 0 ? hx : hx - 12;
      c.fillRect(tabX, RULER, 12, 22);
      c.fillStyle = C.handleGrip;
      for (let g = 0; g < 3; g++) c.fillRect(tabX + 3 + g * 2.5, RULER + 6, 1, 10);
    }
  }

  /**
   * Thumbnail tiles along the filmstrip row. Tile spacing is snapped to a
   * power-of-two number of seconds, so zooming reuses cached thumbnails instead
   * of requesting new ones for every small change in scale.
   */
  function drawFilmstrip(c: CanvasRenderingContext2D, strip: Filmstrip, top: number) {
    const p = propsRef.current;
    const v = view.current;
    const C = colors.current;
    const h = FILM_H - 4;
    const tileW = h * strip.aspect;
    const tileSec = Math.pow(2, Math.ceil(Math.log2(tileW / v.pxPerSec)));
    const span = tileSec * v.pxPerSec;
    c.fillStyle = C.ruler;
    c.fillRect(0, top, v.width, FILM_H);
    const first = Math.floor(v.scroll / tileSec);
    const last = Math.ceil((v.scroll + v.width / v.pxPerSec) / tileSec);
    const wanted: { key: string; time: number }[] = [];
    for (let i = first; i <= last; i++) {
      const start = i * tileSec;
      if (start >= p.duration) break;
      const key = tileSec + ':' + i;
      const x = Math.round((start - v.scroll) * v.pxPerSec);
      const w = Math.max(1, Math.round(Math.min(span, (p.duration - start) * v.pxPerSec)) - 1);
      const bmp = strip.get(key);
      if (bmp) {
        // Cover-fit: a tile is at least as wide as a thumbnail, so crop top and bottom.
        const sh = Math.min(bmp.height, (bmp.width * h) / w);
        c.drawImage(bmp, 0, (bmp.height - sh) / 2, Math.min(bmp.width, (w / h) * sh), sh, x, top + 2, w, h);
      } else {
        c.fillStyle = C.tickMinor;
        c.fillRect(x, top + 2, w, h);
        wanted.push({ key, time: Math.min(start + tileSec / 2, p.duration - 0.05) });
      }
    }
    strip.request(wanted);
  }

  function renderMini() {
    const p = propsRef.current;
    const v = view.current;
    const C = colors.current;
    const c = prepareLayer(miniLayer.current, MINI_H);
    c.fillStyle = C.miniBg;
    c.fillRect(0, 0, v.width, MINI_H);
    const secPerPx = p.duration / v.width;
    const mid = MINI_H / 2;
    const amp = (MINI_H / 2 - 5) * Math.min(waveGain.current, 3);
    for (let x = 0; x < v.width; x++) {
      const t0 = x * secPerPx;
      if (t0 >= p.analysedUntil) {
        drawPending(c, x, 0, v.width, MINI_H);
        break;
      }
      const range = columnRange(t0, t0 + secPerPx);
      if (!range) break;
      c.fillStyle = t0 >= p.trimStart && t0 <= p.trimEnd ? C.miniWaveSel : C.miniWave;
      const top = Math.max(2, mid - range[1] * amp);
      c.fillRect(x, top, 1, Math.max(1, Math.min(MINI_H - 2, mid - range[0] * amp) - top));
    }
    c.fillStyle = C.cutBlock;
    for (const cut of p.cuts) {
      const x0 = Math.round(cut.start / secPerPx);
      c.fillRect(x0, MINI_H - 4, Math.max(1, Math.round(cut.end / secPerPx) - x0), 3);
    }
    c.fillStyle = C.handle;
    c.fillRect(Math.round(p.trimStart / secPerPx), 0, 1, MINI_H);
    c.fillRect(Math.round(p.trimEnd / secPerPx) - 1, 0, 1, MINI_H);
  }

  const localX = (clientX: number) => clientX - canvasRef.current!.getBoundingClientRect().left;
  const localY = (clientY: number) => clientY - canvasRef.current!.getBoundingClientRect().top;

  const timeAt = (clientX: number) => {
    const v = view.current;
    if (!v.pxPerSec) return propsRef.current.getPosition();
    return Math.min(propsRef.current.duration, Math.max(0, v.scroll + localX(clientX) / v.pxPerSec));
  };

  const handleAt = (clientX: number, clientY: number): Drag => {
    if (localY(clientY) > geo().mainH) return null;
    const v = view.current;
    const p = propsRef.current;
    const x = localX(clientX);
    if (Math.abs(x - (p.trimStart - v.scroll) * v.pxPerSec) <= HANDLE_HIT_PX) return 'start';
    if (Math.abs(x - (p.trimEnd - v.scroll) * v.pxPerSec) <= HANDLE_HIT_PX) return 'end';
    return null;
  };

  const applyDrag = (clientX: number) => {
    const p = propsRef.current;
    const v = view.current;
    if (drag.current === 'pan') {
      v.scroll = (localX(clientX) - panGrab.current) / (v.width / p.duration);
      clampView();
      return;
    }
    const t = timeAt(clientX);
    if (drag.current === 'start') p.onTrimChange(Math.min(t, p.trimEnd - MIN_CLIP), p.trimEnd);
    else if (drag.current === 'end') p.onTrimChange(p.trimStart, Math.max(t, p.trimStart + MIN_CLIP));
    else if (drag.current === 'playhead') p.onSeek(t);
  };

  const hasFilm = !!props.filmstrip;
  return (
    <div className="timeline-wrap">
      <div className="track-headers" aria-hidden="true">
        <div className="track-header track-header-ruler" style={{ height: RULER }} />
        {hasFilm && (
          <div className="track-header" style={{ height: FILM_H }}>
            Video
          </div>
        )}
        <div className="track-header" style={{ height: WAVE_H }}>
          Audio
        </div>
        <div className="track-header track-header-lane" style={{ height: LANE_H }}>
          Gaps
        </div>
        <div className="track-header track-header-mini" style={{ height: MINI_H + GAP }}>
          Overview
        </div>
      </div>
    <canvas
      ref={canvasRef}
      className="timeline"
      style={{ height: geometry(hasFilm).height }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        if (localY(e.clientY) > geo().mainH) {
          // Minimap: grab the viewport box, or jump it so the click point is centred.
          const v = view.current;
          const scale = v.width / propsRef.current.duration;
          const vx = v.scroll * scale;
          const vw = (v.width / v.pxPerSec) * scale;
          const x = localX(e.clientX);
          panGrab.current = x >= vx && x <= vx + vw ? x - vx : vw / 2;
          drag.current = 'pan';
        } else {
          const handle = handleAt(e.clientX, e.clientY);
          const item = !handle && localY(e.clientY) >= geo().laneTop ? laneItemAt(localX(e.clientX)) : null;
          if (item) {
            drag.current = null;
            propsRef.current.onToggleSilence({ start: item.start, end: item.end });
            return;
          }
          drag.current = handle ?? 'playhead';
        }
        applyDrag(e.clientX);
      }}
      onPointerMove={(e) => {
        const y = localY(e.clientY);
        const G = geo();
        const inMain = y <= G.mainH;
        hoverX.current = inMain ? localX(e.clientX) : null;
        hoverY.current = y;
        if (drag.current) applyDrag(e.clientX);
        else if (!inMain) e.currentTarget.style.cursor = 'grab';
        else if (handleAt(e.clientX, e.clientY)) e.currentTarget.style.cursor = 'ew-resize';
        else if (y >= G.laneTop && laneItemAt(localX(e.clientX))) e.currentTarget.style.cursor = 'pointer';
        else e.currentTarget.style.cursor = 'text';
      }}
      onPointerLeave={() => (hoverX.current = null)}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    />
    </div>
  );
}
