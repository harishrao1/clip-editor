import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { Player } from '../audio/player';
import { VideoPreview } from '../video/client';
import { cropRect, FRAMES, type CropCenter, type FrameId } from '../video/crop';
import type { VideoStats } from '../video/protocol';

type CropProps = {
  /** Framing to preview; 'original' shows no crop box. */
  frame: FrameId;
  crop: CropCenter;
  onCropChange: (crop: CropCenter) => void;
};

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; width: number; height: number; codec: string }
  | { kind: 'unavailable'; reason: string };

const CODEC_NAMES: Record<string, string> = { avc: 'H.264', hevc: 'H.265', vp8: 'VP8', vp9: 'VP9', av1: 'AV1' };

/** Video preview, decoded and drawn in a worker, following the audio playhead. */
export function VideoPanel({ file, player, frame, crop, onCropChange }: { file: File; player: Player } & CropProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [stats, setStats] = useState<VideoStats | null>(null);

  useEffect(() => {
    const stage = stageRef.current!;
    // A fresh canvas per mount: transferControlToOffscreen() can only be called once per element.
    const canvas = document.createElement('canvas');
    canvas.className = 'video-canvas';
    stage.appendChild(canvas);
    setState({ kind: 'loading' });
    setStats(null);

    const preview = new VideoPreview(file, canvas, (msg) => {
      if (msg.type === 'ready') setState({ kind: 'ready', width: msg.width, height: msg.height, codec: msg.codec });
      else if (msg.type === 'unavailable') setState({ kind: 'unavailable', reason: msg.reason });
      else if (msg.type === 'error') setState({ kind: 'unavailable', reason: msg.message });
      else if (msg.type === 'stats') setStats(msg.stats);
    });

    const ro = new ResizeObserver(([entry]) => {
      const dpr = devicePixelRatio;
      preview.resize(Math.round(entry.contentRect.width * dpr), Math.round(entry.contentRect.height * dpr));
    });
    ro.observe(canvas);

    // Publish the playhead every frame. With a shared clock this is two memory writes, no messages.
    let raf = 0;
    const tick = () => {
      preview.setTime(player.position, player.playing);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      preview.dispose();
      canvas.remove();
    };
  }, [file, player]);

  const aspect = state.kind === 'ready' && state.height > 0 ? state.width / state.height : 16 / 9;

  return (
    <section className="panel video-panel" aria-label="Video preview">
      <div className="video-stage" ref={stageRef} style={{ '--aspect': aspect } as CSSProperties}>
        {state.kind === 'loading' && <span className="video-message">Opening video…</span>}
        {state.kind === 'unavailable' && <span className="video-message">{state.reason}</span>}
        {state.kind === 'ready' && FRAMES[frame].aspect !== null && (
          <CropBox
            sourceW={state.width}
            sourceH={state.height}
            aspect={FRAMES[frame].aspect!}
            label={FRAMES[frame].label}
            crop={crop}
            onCropChange={onCropChange}
          />
        )}
      </div>
      {state.kind === 'ready' && (
        <div className="video-meta">
          <span>
            {state.width}×{state.height} {CODEC_NAMES[state.codec] ?? state.codec}
          </span>
          {stats && (
            <span
              className="video-stats"
              title="Decoded frames live in a small pool of GPU memory outside the garbage collector. Each is closed as soon as it has been drawn, so open frames stay at 1 while playing and 0 when paused."
            >
              {stats.drawn.toLocaleString()} drawn · {stats.dropped.toLocaleString()} dropped · {stats.open} open{' '}
              {stats.open === 1 ? 'frame' : 'frames'} · last seek {stats.lastSeekMs} ms
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The export frame drawn over the preview: everything outside is dimmed. Drag
 * it, or click anywhere on the video to centre it there. Positions are kept as
 * fractions of the source frame, so they survive resizing the panel.
 */
function CropBox(props: {
  sourceW: number;
  sourceH: number;
  aspect: number;
  label: string;
  crop: CropCenter;
  onCropChange: (crop: CropCenter) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const grab = useRef<{ dx: number; dy: number } | null>(null);
  const rect = cropRect(props.sourceW, props.sourceH, props.aspect, props.crop);
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;

  // Pointer position as a fraction of the frame.
  const fraction = (e: ReactPointerEvent) => {
    const r = layerRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const centre = { x: (rect.x + rect.width / 2) / props.sourceW, y: (rect.y + rect.height / 2) / props.sourceH };
  // Store the clamped centre, so dragging past an edge doesn't leave slack to drag back through.
  const commit = (x: number, y: number) => {
    const r = cropRect(props.sourceW, props.sourceH, props.aspect, { x, y });
    props.onCropChange({ x: (r.x + r.width / 2) / props.sourceW, y: (r.y + r.height / 2) / props.sourceH });
  };

  return (
    <div
      ref={layerRef}
      className="crop-layer"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const f = fraction(e);
        const inside =
          f.x * props.sourceW >= rect.x &&
          f.x * props.sourceW <= rect.x + rect.width &&
          f.y * props.sourceH >= rect.y &&
          f.y * props.sourceH <= rect.y + rect.height;
        // Inside the box: drag it by the point grabbed. Outside: jump it there, then drag.
        grab.current = inside ? { dx: f.x - centre.x, dy: f.y - centre.y } : { dx: 0, dy: 0 };
        if (!inside) commit(f.x, f.y);
      }}
      onPointerMove={(e) => {
        if (!grab.current) return;
        const f = fraction(e);
        commit(f.x - grab.current.dx, f.y - grab.current.dy);
      }}
      onPointerUp={() => (grab.current = null)}
      onPointerCancel={() => (grab.current = null)}
    >
      <div
        className="crop-box"
        style={{
          left: pct(rect.x, props.sourceW),
          top: pct(rect.y, props.sourceH),
          width: pct(rect.width, props.sourceW),
          height: pct(rect.height, props.sourceH),
        }}
      >
        <span className="crop-label">{props.label}</span>
      </div>
    </div>
  );
}
