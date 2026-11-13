import { CLOCK_LENGTH, CLOCK_PLAYING, CLOCK_TIME, type FromVideoWorker, type ToVideoWorker } from './protocol';

/**
 * Main-thread handle to the video preview worker. The canvas is handed over
 * with transferControlToOffscreen, so after open() only the worker draws to it.
 */
export class VideoPreview {
  private worker = new Worker(new URL('./video.worker.ts', import.meta.url), { type: 'module' });
  private clock: Float64Array | null = null;

  constructor(file: File, canvas: HTMLCanvasElement, onMessage: (msg: FromVideoWorker) => void) {
    this.worker.onmessage = (e: MessageEvent<FromVideoWorker>) => onMessage(e.data);
    this.worker.onerror = (e) => onMessage({ type: 'error', message: e.message || 'The video worker crashed.' });

    // SharedArrayBuffer needs cross-origin isolation; without it the clock goes by postMessage.
    const shared = crossOriginIsolated ? new SharedArrayBuffer(CLOCK_LENGTH * Float64Array.BYTES_PER_ELEMENT) : null;
    this.clock = shared ? new Float64Array(shared) : null;

    const offscreen = canvas.transferControlToOffscreen();
    this.send({ type: 'open', file, canvas: offscreen, clock: shared }, [offscreen]);
  }

  /** Called every animation frame with the playhead. A plain memory write when the clock is shared. */
  setTime(time: number, playing: boolean) {
    if (this.clock) {
      this.clock[CLOCK_TIME] = time;
      this.clock[CLOCK_PLAYING] = playing ? 1 : 0;
    } else {
      this.send({ type: 'clock', time, playing });
    }
  }

  resize(width: number, height: number) {
    this.send({ type: 'resize', width, height });
  }

  dispose() {
    // Terminating the worker releases its decoder and any frames it still holds.
    this.worker.terminate();
  }

  private send(msg: ToVideoWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(msg, transfer);
  }
}
