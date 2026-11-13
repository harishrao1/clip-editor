import type { FromWorker, MediaInfo, ToWorker } from './protocol';

export type IngestHandlers = {
  onInfo: (info: MediaInfo, fromCache: boolean) => void;
  onPeaks: (offset: number, data: Float32Array, energy: Float32Array, analysedUntil: number) => void;
  onDone: (ms: number, fromCache: boolean) => void;
  onError: (message: string, unsupported: boolean) => void;
};

/** Main-thread handle to one opened file. One worker per file; dispose() stops all work. */
export class Ingest {
  private worker = new Worker(new URL('./ingest.worker.ts', import.meta.url), { type: 'module' });
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: AudioBuffer) => void; reject: (e: Error) => void }>();

  constructor(readonly file: File, samplesPerPeak: number, handlers: IngestHandlers) {
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'info':
          return handlers.onInfo(msg.info, msg.fromCache);
        case 'peaks':
          return handlers.onPeaks(msg.offset, msg.data, msg.energy, msg.analysedUntil);
        case 'done':
          return handlers.onDone(msg.ms, msg.fromCache);
        case 'error':
          return handlers.onError(msg.message, msg.unsupported);
        case 'range': {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          const buffer = new AudioBuffer({
            length: msg.channels[0].length,
            numberOfChannels: msg.channels.length,
            sampleRate: msg.sampleRate,
          });
          msg.channels.forEach((data, c) => buffer.copyToChannel(data, c));
          return p?.resolve(buffer);
        }
        case 'rangeError': {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          return p?.reject(new Error(msg.message));
        }
      }
    };
    this.worker.onerror = (e) => handlers.onError(e.message || 'The ingest worker crashed.', false);
    this.send({ type: 'open', file, samplesPerPeak });
  }

  /** Decodes just [start, end) of the file. Memory use is proportional to the clip, not the file. */
  readRange(start: number, end: number): Promise<AudioBuffer> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ type: 'readRange', id, start, end });
    });
  }

  dispose() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('The file was closed.'));
    this.pending.clear();
  }

  private send(msg: ToWorker) {
    this.worker.postMessage(msg);
  }
}
