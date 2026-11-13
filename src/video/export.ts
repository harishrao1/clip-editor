import type { ExportJob, FromExportWorker } from './export.protocol';

export type ExportResult = Extract<FromExportWorker, { type: 'done' }>;

/**
 * Runs one video export in its own worker. `cancel()` terminates the worker,
 * which stops the encoders immediately; the partial file is cleared by the next export.
 */
export function exportVideo(job: ExportJob, onProgress: (stage: string, ratio: number) => void) {
  const worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
  let rejectRun: (e: Error) => void = () => {};

  const promise = new Promise<ExportResult>((resolve, reject) => {
    rejectRun = reject;
    worker.onmessage = (e: MessageEvent<FromExportWorker>) => {
      const msg = e.data;
      if (msg.type === 'progress') return onProgress(msg.stage, msg.ratio);
      worker.terminate();
      if (msg.type === 'done') resolve(msg);
      else reject(new Error(msg.message));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'The export worker crashed.'));
    };
  });

  const transfer = job.audio ? job.audio.channels.map((c) => c.buffer) : [];
  worker.postMessage({ type: 'start', job }, transfer);

  return {
    promise,
    cancel() {
      worker.terminate();
      rejectRun(new ExportCancelled());
    },
  };
}

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled');
  }
}
