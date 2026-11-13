/**
 * Playback through an AnalyserNode, from one of two backends:
 *  - BufferBackend plays an in-memory AudioBuffer (the sample, small fallbacks).
 *  - MediaBackend streams a File from disk through a media element, so a long
 *    recording never has to be decoded into RAM just to be heard.
 * Both report position from the AudioContext clock.
 */
interface Backend {
  readonly playing: boolean;
  readonly position: number;
  play(from: number, until: number): Promise<void>;
  pause(): void;
  seek(t: number, until: number): void;
  dispose(): void;
}

export class Player {
  readonly ctx = new AudioContext();
  readonly analyser: AnalyserNode;
  onEnded?: () => void;
  onError?: (message: string) => void;

  private backend: Backend | null = null;
  private skips: { start: number; end: number }[] = [];
  private until = 0;
  private skipTimer = 0;

  constructor() {
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;
    this.analyser.connect(this.ctx.destination);
  }

  get playing() {
    return this.backend?.playing ?? false;
  }

  get position() {
    return this.backend?.position ?? 0;
  }

  loadBuffer(buffer: AudioBuffer) {
    this.backend?.dispose();
    this.backend = new BufferBackend(this.ctx, this.analyser, buffer, () => this.onEnded?.());
  }

  loadFile(file: File) {
    this.backend?.dispose();
    this.backend = new MediaBackend(
      this.ctx,
      this.analyser,
      file,
      () => this.onEnded?.(),
      (m) => this.onError?.(m),
    );
  }

  unload() {
    clearInterval(this.skipTimer);
    this.backend?.dispose();
    this.backend = null;
  }

  /** Ranges to jump over during playback, so cut silences are heard as the export will sound. */
  setSkips(ranges: { start: number; end: number }[]) {
    this.skips = ranges;
  }

  async play(from: number, until: number) {
    await this.ctx.resume();
    this.until = until;
    await this.backend?.play(this.skipTarget(from) ?? from, until);
    clearInterval(this.skipTimer);
    this.skipTimer = window.setInterval(this.checkSkips, 15);
  }

  pause() {
    clearInterval(this.skipTimer);
    this.backend?.pause();
  }

  seek(t: number, until: number) {
    this.until = until;
    this.backend?.seek(t, until);
  }

  private skipTarget(t: number): number | null {
    for (const s of this.skips) {
      if (t >= s.start && t < s.end - 0.01 && s.end < this.until) return s.end;
    }
    return null;
  }

  private checkSkips = () => {
    if (!this.backend?.playing) return clearInterval(this.skipTimer);
    const target = this.skipTarget(this.backend.position);
    if (target !== null) this.backend.seek(target, this.until);
  };
}

class BufferBackend implements Backend {
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private offset = 0;
  private until = 0;

  constructor(
    private ctx: AudioContext,
    private destination: AudioNode,
    private buffer: AudioBuffer,
    private onEnded: () => void,
  ) {}

  get playing() {
    return this.source !== null;
  }

  get position() {
    if (!this.source) return this.offset;
    return Math.min(this.until, this.offset + this.ctx.currentTime - this.startedAt);
  }

  async play(from: number, until: number) {
    this.stopSource();
    // AudioBufferSourceNodes are one-shot, so every play/seek creates a new one.
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.destination);
    src.onended = () => {
      // Ignore ends caused by our own stop() calls.
      if (this.source !== src) return;
      this.source = null;
      this.offset = this.until;
      this.onEnded();
    };
    src.start(0, from, Math.max(0, until - from));
    this.source = src;
    this.startedAt = this.ctx.currentTime;
    this.offset = from;
    this.until = until;
  }

  pause() {
    if (!this.source) return;
    this.offset = this.position;
    this.stopSource();
  }

  seek(t: number, until: number) {
    if (this.source) void this.play(t, until);
    else this.offset = t;
  }

  dispose() {
    this.stopSource();
  }

  private stopSource() {
    const src = this.source;
    this.source = null;
    src?.stop();
    src?.disconnect();
  }
}

class MediaBackend implements Backend {
  private el = new Audio();
  private node: MediaElementAudioSourceNode;
  private url: string;
  private isPlaying = false;
  private offset = 0;
  private until = 0;
  private timer = 0;
  // Media time and AudioContext time captured together; position extrapolates from them.
  private anchor: { media: number; ctx: number } | null = null;

  constructor(
    private ctx: AudioContext,
    destination: AudioNode,
    file: File,
    private onEnded: () => void,
    onError: (message: string) => void,
  ) {
    this.url = URL.createObjectURL(file);
    this.el.preload = 'auto';
    this.el.src = this.url;
    this.node = ctx.createMediaElementSource(this.el);
    this.node.connect(destination);
    this.el.addEventListener('playing', this.reanchor);
    this.el.addEventListener('seeked', this.reanchor);
    this.el.addEventListener('error', () =>
      onError("This browser can't play this file directly. You can still mark and export a clip."),
    );
  }

  get playing() {
    return this.isPlaying;
  }

  get position() {
    if (!this.isPlaying) return this.offset;
    if (!this.anchor) return this.el.currentTime;
    // element.currentTime updates in coarse steps; the AudioContext clock is smooth and on the same output.
    const t = this.anchor.media + (this.ctx.currentTime - this.anchor.ctx) * this.el.playbackRate;
    return Math.min(t, this.until);
  }

  async play(from: number, until: number) {
    this.until = until;
    this.offset = from;
    this.anchor = null;
    this.el.currentTime = from;
    this.isPlaying = true;
    try {
      await this.el.play();
    } catch (err) {
      this.isPlaying = false;
      throw err;
    }
    // A timer, not rAF, so the clip still stops at its end in a background tab.
    clearInterval(this.timer);
    this.timer = window.setInterval(this.check, 20);
  }

  pause() {
    if (!this.isPlaying) return;
    this.offset = this.position;
    this.stop();
  }

  seek(t: number, until: number) {
    if (this.isPlaying) void this.play(t, until);
    else {
      this.offset = t;
      this.el.currentTime = t;
    }
  }

  dispose() {
    this.stop();
    this.node.disconnect();
    this.el.removeAttribute('src');
    this.el.load();
    URL.revokeObjectURL(this.url);
  }

  private stop() {
    this.isPlaying = false;
    clearInterval(this.timer);
    this.el.pause();
  }

  private reanchor = () => {
    this.anchor = this.el.paused ? null : { media: this.el.currentTime, ctx: this.ctx.currentTime };
  };

  private check = () => {
    if (!this.isPlaying) return;
    if (this.el.currentTime >= this.until || this.el.ended) {
      this.offset = this.until;
      this.stop();
      this.onEnded();
      return;
    }
    // Re-sync if the extrapolated clock has drifted from the element (e.g. after a stall).
    if (this.anchor && Math.abs(this.position - this.el.currentTime) > 0.15) this.reanchor();
  };
}
