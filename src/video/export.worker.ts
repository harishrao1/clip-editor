/**
 * Video export worker: kept segments → decode → crop/scale on an OffscreenCanvas
 * → WebCodecs VideoEncoder (H.264) + AudioEncoder (AAC) → MP4.
 *
 * The muxer writes through a StreamTarget straight into a file in the Origin
 * Private File System, so the finished video never has to fit in memory. Each
 * decoded and each composed frame is closed as soon as it has been handed on.
 */
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BlobSource,
  canEncodeAudio,
  canEncodeVideo,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  type AudioCodec,
} from 'mediabunny';
import type { ExportJob, FromExportWorker, ToExportWorker } from './export.protocol';

const post = (msg: FromExportWorker) => (self as unknown as Worker).postMessage(msg);

const EXPORT_DIR = 'exports';
const AUDIO_CHUNK_SEC = 1;
const PROGRESS_INTERVAL_MS = 150;

self.onmessage = (e: MessageEvent<ToExportWorker>) => {
  if (e.data.type === 'start') {
    run(e.data.job).catch((err) => post({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
  }
};

async function run(job: ExportJob) {
  const started = performance.now();
  const { width: outW, height: outH } = job.output;

  if (!(await canEncodeVideo('avc', { width: outW, height: outH }))) {
    throw new Error(`This browser can't encode H.264 video at ${outW}×${outH}.`);
  }
  let audioCodec: AudioCodec | null = null;
  if (job.audio) {
    audioCodec = (await canEncodeAudio('aac')) ? 'aac' : (await canEncodeAudio('opus')) ? 'opus' : null;
    if (!audioCodec) throw new Error("This browser can't encode AAC or Opus audio.");
  }

  const input = new Input({ source: new BlobSource(job.file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('This file has no video track.');
  const fps = Math.round((await track.computePacketStats(120)).averagePacketRate) || 30;

  // One export is kept at a time: clear the previous one, then stream into a new file.
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(EXPORT_DIR, { create: true });
  const old: string[] = [];
  for await (const name of dir.keys()) old.push(name);
  for (const name of old) await dir.removeEntry(name).catch(() => {});
  const handle = await dir.getFileHandle(job.fileName, { create: true });
  const writable = await handle.createWritable();

  const output = new Output({
    format: new Mp4OutputFormat(),
    // FileSystemWritableFileStream accepts positioned writes, which is exactly what StreamTarget emits.
    target: new StreamTarget(writable as unknown as WritableStream, { chunked: true }),
  });
  const videoSource = new VideoSampleSource({ codec: 'avc', bitrate: QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(videoSource, { frameRate: fps });
  const audioSource = audioCodec ? new AudioSampleSource({ codec: audioCodec, bitrate: 160_000 }) : null;
  if (audioSource) output.addAudioTrack(audioSource);
  await output.start();

  const total = job.segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  let lastProgress = 0;
  const progress = (stage: string, ratio: number) => {
    const now = performance.now();
    if (now - lastProgress < PROGRESS_INTERVAL_MS && ratio < 1) return;
    lastProgress = now;
    post({ type: 'progress', stage, ratio });
  };

  // Audio: already rendered on the main thread; encode it in one-second chunks.
  if (job.audio && audioSource) {
    const { channels, sampleRate } = job.audio;
    const length = channels[0].length;
    const chunk = Math.round(AUDIO_CHUNK_SEC * sampleRate);
    for (let offset = 0; offset < length; offset += chunk) {
      const frames = Math.min(chunk, length - offset);
      const planar = new Float32Array(frames * channels.length);
      channels.forEach((data, c) => planar.set(data.subarray(offset, offset + frames), c * frames));
      const sample = new AudioSample({
        data: planar,
        format: 'f32-planar',
        numberOfChannels: channels.length,
        sampleRate,
        timestamp: offset / sampleRate,
      });
      await audioSource.add(sample);
      sample.close();
      progress('Encoding audio', 0.1 * (offset / length));
    }
    audioSource.close();
  }

  // Video: decode only the kept segments, crop each frame, re-time it onto the joined timeline.
  const sink = new VideoSampleSink(track);
  // Frames are first drawn at full display size (which applies any rotation), then cropped and scaled.
  const full = new OffscreenCanvas(track.displayWidth, track.displayHeight);
  const fullCtx = full.getContext('2d')!;
  const out = new OffscreenCanvas(outW, outH);
  const outCtx = out.getContext('2d')!;
  outCtx.imageSmoothingQuality = 'high';
  const { crop } = job;

  // Output is constant frame rate: every frame sits on a 1/fps grid (the track's
  // frameRate makes the muxer snap to it anyway). Around a cut, two source frames
  // can fall into the same grid slot; keeping both would give two frames one
  // timestamp, so only the first is kept.
  const frameDur = 1 / fps;
  const snap = (t: number) => Math.round(t * fps) / fps;
  let base = 0;
  let lastTimestamp = -Infinity;
  let frames = 0;
  for (const seg of job.segments) {
    const segEnd = snap(base + (seg.end - seg.start));
    for await (const sample of sink.samples(seg.start, seg.end)) {
      try {
        // The first frame of a segment usually starts slightly before it; pin it to the join.
        const timestamp = snap(base + Math.max(0, sample.timestamp - seg.start));
        if (timestamp <= lastTimestamp || timestamp >= segEnd) continue;
        const duration = frameDur;

        sample.drawWithFit(fullCtx, { fit: 'fill' });
        outCtx.drawImage(full, crop.x, crop.y, crop.width, crop.height, 0, 0, outW, outH);
        const composed = new VideoSample(out, { timestamp, duration });
        // add() waits while the encoder is busy, which keeps memory flat.
        await videoSource.add(composed);
        composed.close();

        lastTimestamp = timestamp;
        frames++;
        progress('Encoding video', 0.1 + 0.88 * Math.min(1, (timestamp + duration) / total));
      } finally {
        sample.close();
      }
    }
    base += seg.end - seg.start;
  }
  videoSource.close();

  progress('Finishing the file', 0.99);
  await output.finalize();
  const file = await handle.getFile();
  post({ type: 'done', file, frames, ms: performance.now() - started, videoCodec: 'avc', audioCodec });
}
