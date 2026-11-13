/** Output framing for video export, and the crop geometry behind it. */

export type FrameId = 'portrait' | 'square' | 'original';

export const FRAMES: Record<FrameId, { label: string; hint: string; aspect: number | null }> = {
  portrait: { label: '9:16', hint: 'Shorts, Reels, TikTok', aspect: 9 / 16 },
  square: { label: '1:1', hint: 'Feed posts', aspect: 1 },
  original: { label: 'Original', hint: 'Full frame, no crop', aspect: null },
};

/** Where the crop window sits, as its centre in 0–1 of the source frame. */
export type CropCenter = { x: number; y: number };

export type Rect = { x: number; y: number; width: number; height: number };

/** The largest window of the given aspect that fits the source, positioned by `center`. */
export function cropRect(sourceW: number, sourceH: number, aspect: number | null, center: CropCenter): Rect {
  if (aspect === null) return { x: 0, y: 0, width: sourceW, height: sourceH };
  const width = sourceW / sourceH > aspect ? sourceH * aspect : sourceW;
  const height = width / aspect;
  const clamp = (v: number, max: number) => Math.min(Math.max(0, v), max);
  return {
    x: clamp(center.x * sourceW - width / 2, sourceW - width),
    y: clamp(center.y * sourceH - height / 2, sourceH - height),
    width,
    height,
  };
}

/** Encoded size: social-standard 1080 wide for cropped frames, the source size (even numbers) otherwise. */
export function outputSize(frame: FrameId, sourceW: number, sourceH: number): { width: number; height: number } {
  if (frame === 'portrait') return { width: 1080, height: 1920 };
  if (frame === 'square') return { width: 1080, height: 1080 };
  // H.264 needs even dimensions.
  return { width: Math.round(sourceW / 2) * 2, height: Math.round(sourceH / 2) * 2 };
}
