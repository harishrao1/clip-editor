/** Thumbnails held for the timeline; older ones are closed to free their memory. */
const CACHE_LIMIT = 500;

/**
 * Main-thread side of the timeline filmstrip. The timeline asks for the tiles
 * it can see (`request`) and reads whatever has arrived (`get`); thumbnails are
 * decoded in their own worker so scrolling never waits on the decoder.
 */
export class Filmstrip {
  /** Width ÷ height of the video, known once the worker has opened the track. */
  aspect = 16 / 9;
  /** Called when a new thumbnail arrives, so the timeline can redraw. */
  onUpdate?: () => void;

  private worker = new Worker(new URL('./thumbs.worker.ts', import.meta.url), { type: 'module' });
  private cache = new Map<string, ImageBitmap>();
  private lastRequest = '';

  constructor(file: File, tileHeightCss: number) {
    this.worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'ready') {
        this.aspect = msg.aspect;
        this.onUpdate?.();
      } else if (msg.type === 'thumb') {
        this.cache.set(msg.key, msg.bitmap);
        this.evict();
        this.onUpdate?.();
      }
    };
    // Decode at twice the CSS height so tiles stay sharp on HiDPI screens.
    this.worker.postMessage({ type: 'open', file, height: Math.round(tileHeightCss * 2) });
  }

  get(key: string): ImageBitmap | undefined {
    const bmp = this.cache.get(key);
    if (bmp) {
      // Refresh recency.
      this.cache.delete(key);
      this.cache.set(key, bmp);
    }
    return bmp;
  }

  /** The tiles currently visible but not cached. Only re-sent when the set changes. */
  request(tiles: { key: string; time: number }[]) {
    const id = tiles.map((t) => t.key).join('|');
    if (id === this.lastRequest) return;
    this.lastRequest = id;
    this.worker.postMessage({ type: 'want', requests: tiles });
  }

  dispose() {
    this.worker.terminate();
    for (const bmp of this.cache.values()) bmp.close();
    this.cache.clear();
  }

  private evict() {
    while (this.cache.size > CACHE_LIMIT) {
      const [key, bmp] = this.cache.entries().next().value!;
      bmp.close();
      this.cache.delete(key);
    }
  }
}
