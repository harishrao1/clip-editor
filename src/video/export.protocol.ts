import type { Range } from '../audio/silence';
import type { Rect } from './crop';

export type ExportJob = {
  file: File;
  /** Source ranges to keep, in order; they are joined back to back. */
  segments: Range[];
  /** Crop window in source display pixels. */
  crop: Rect;
  output: { width: number; height: number };
  /** The finished soundtrack (trim, cuts, gain and fades already applied), planar. Transferred. */
  audio: { channels: Float32Array<ArrayBuffer>[]; sampleRate: number } | null;
  fileName: string;
};

export type ToExportWorker = { type: 'start'; job: ExportJob };

export type FromExportWorker =
  | { type: 'progress'; stage: string; ratio: number }
  /** `file` is the MP4 in the Origin Private File System: disk-backed, not held in memory. */
  | { type: 'done'; file: File; frames: number; ms: number; videoCodec: string; audioCodec: string | null }
  | { type: 'error'; message: string };
