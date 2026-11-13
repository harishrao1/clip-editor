import { useEffect, useRef } from 'react';
import { readColors } from '../theme';

/** One bar per this many CSS pixels, so the spectrum stays fine-grained at any width. */
const BAR_PITCH = 9;
const MIN_BARS = 32;
const MAX_BARS = 160;
const CAP_FALL = 0.5; // px per frame

const COLOR_VARS = { bar: '--viz-bar', cap: '--viz-cap', base: '--viz-base' };

/**
 * Log-spaced frequency bars with falling peak markers, read from an
 * AnalyserNode every frame. Fills whatever box its container gives it.
 */
export function Visualizer({ analyser, theme }: { analyser: AnalyserNode; theme: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const colors = readColors(COLOR_VARS);
    const bins = new Uint8Array(analyser.frequencyBinCount);
    let bars = 0;
    let edges: number[] = [];
    let caps = new Float32Array(0);
    // Map bars to bins logarithmically so bass doesn't get squashed into one bar.
    const layout = (count: number) => {
      bars = count;
      edges = Array.from({ length: count + 1 }, (_, i) => Math.min(bins.length, Math.round(Math.pow(bins.length, i / count))));
      caps = new Float32Array(count);
    };
    let raf = 0;

    const frame = () => {
      const dpr = devicePixelRatio;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      analyser.getByteFrequencyData(bins);

      const wanted = Math.min(MAX_BARS, Math.max(MIN_BARS, Math.round(w / BAR_PITCH)));
      if (wanted !== bars) layout(wanted);
      const slot = w / bars;
      const gap = Math.max(1, Math.round(slot * 0.3));
      const barW = Math.max(1, Math.floor(slot) - gap);
      const floor = h - 1;

      ctx.fillStyle = colors.base;
      ctx.fillRect(0, floor, w, 1);

      for (let b = 0; b < bars; b++) {
        let peak = 0;
        for (let i = edges[b]; i < Math.max(edges[b] + 1, edges[b + 1]); i++) {
          if (bins[i] > peak) peak = bins[i];
        }
        const barH = Math.round((peak / 255) * (h - 8));
        const x = Math.round(b * slot);
        if (barH > 0) {
          ctx.fillStyle = colors.bar;
          ctx.fillRect(x, floor - barH, barW, barH);
        }
        caps[b] = Math.max(barH, caps[b] - CAP_FALL * (h / 80));
        if (caps[b] > 2) {
          ctx.fillStyle = colors.cap;
          ctx.fillRect(x, Math.round(floor - caps[b] - 4), barW, 2);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [analyser, theme]);

  return <canvas ref={canvasRef} className="visualizer" />;
}
