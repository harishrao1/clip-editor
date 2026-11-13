/**
 * Ingest worker. Opens a File without reading it into memory: Mediabunny's
 * BlobSource reads slices on demand, the container is demuxed into encoded
 * packets, and WebCodecs decodes them. Each decoded sample is folded into
 * min/max peak buckets and closed straight away, so no PCM for the whole file
 * is ever held. Peaks stream back to the main thread as they are computed.
 */
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input, type InputAudioTrack } from 'mediabunny';
import { cacheKey, loadPeaks, savePeaks } from './peakCache';
import type { FromWorker, MediaInfo, ToWorker } from './protocol';

const POST_INTERVAL_MS = 250;

const post = (msg: FromWorker, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

let audioTrack: InputAudioTrack | null = null;
let decoded: { sampleRate: number; numberOfChannels: number } | null = null;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'open') void open(msg.file, msg.samplesPerPeak);
  else if (msg.type === 'readRange') void readRange(msg.id, msg.start, msg.end);
};

async function open(file: File, samplesPerPeak: number) {
  const started = performance.now();
  const key = cacheKey(file, samplesPerPeak);
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });

  try {
    if (!(await input.canRead())) {
      return post({ type: 'error', message: "This file's format isn't recognised.", unsupported: true });
    }
    const track = await input.getPrimaryAudioTrack();
    if (!track) {
      return post({ type: 'error', message: 'This file has no audio track.', unsupported: false });
    }
    if (!(await track.canDecode())) {
      const codec = (await track.getCodec()) ?? 'this';
      return post({ type: 'error', message: `This browser can't decode ${codec} audio.`, unsupported: true });
    }
    audioTrack = track;

    const cached = await loadPeaks(key);
    if (cached) {
      decoded = { sampleRate: cached.info.sampleRate, numberOfChannels: cached.info.numberOfChannels };
      post({ type: 'info', info: cached.info, fromCache: true });
      post(
        { type: 'peaks', offset: 0, data: cached.peaks, energy: cached.energy, analysedUntil: cached.info.duration },
        [cached.peaks.buffer, cached.energy.buffer],
      );
      return post({ type: 'done', ms: performance.now() - started, fromCache: true });
    }

    const [format, duration, video] = await Promise.all([
      input.getFormat(),
      input.computeDuration(),
      input.getPrimaryVideoTrack(),
    ]);

    const sink = new AudioSampleSink(track);
    let info: MediaInfo | null = null;
    let peaks = new Float32Array(0);
    let energy = new Float32Array(0);

    // Current bucket state, carried across samples (buckets rarely align with sample boundaries).
    let bucket = -1;
    let min = Infinity;
    let max = -Infinity;
    let sumSq = 0;
    let filled = 0;
    let postedUpTo = 0;
    let lastPost = performance.now();
    let scratch: Float32Array[] = [];

    const flushBucket = () => {
      if (bucket >= 0 && bucket < energy.length && filled > 0) {
        peaks[bucket * 2] = min;
        peaks[bucket * 2 + 1] = max;
        energy[bucket] = sumSq / filled;
      }
    };
    const postPeaks = (upTo: number, analysedUntil: number) => {
      if (upTo <= postedUpTo) return;
      const data = peaks.slice(postedUpTo * 2, upTo * 2);
      const e = energy.slice(postedUpTo, upTo);
      post({ type: 'peaks', offset: postedUpTo, data, energy: e, analysedUntil }, [data.buffer, e.buffer]);
      postedUpTo = upTo;
      lastPost = performance.now();
    };

    for await (const sample of sink.samples()) {
      try {
        if (!info) {
          // The first decoded sample tells us the real output rate and channel count.
          decoded = { sampleRate: sample.sampleRate, numberOfChannels: sample.numberOfChannels };
          const peakCount = Math.ceil((duration * sample.sampleRate) / samplesPerPeak);
          peaks = new Float32Array(peakCount * 2);
          energy = new Float32Array(peakCount);
          info = {
            duration,
            sampleRate: sample.sampleRate,
            numberOfChannels: sample.numberOfChannels,
            container: format.name,
            audioCodec: track.codec ?? 'unknown',
            video: video ? { codec: video.codec ?? 'unknown', width: video.displayWidth, height: video.displayHeight } : null,
            peakCount,
          };
          post({ type: 'info', info, fromCache: false });
        }

        const frames = sample.numberOfFrames;
        const channels = sample.numberOfChannels;
        if (scratch.length !== channels || scratch[0].length < frames) {
          scratch = Array.from({ length: channels }, () => new Float32Array(Math.max(frames, 4096)));
        }
        for (let c = 0; c < channels; c++) {
          sample.copyTo(scratch[c].subarray(0, frames), { planeIndex: c, format: 'f32-planar' });
        }

        // Position by timestamp rather than by counting, so gaps and priming offsets stay aligned.
        const startFrame = Math.round(sample.timestamp * info.sampleRate);
        const scale = 1 / channels;
        let i = Math.max(0, -startFrame);
        while (i < frames) {
          const b = Math.floor((startFrame + i) / samplesPerPeak);
          if (b !== bucket) {
            flushBucket();
            bucket = b;
            min = Infinity;
            max = -Infinity;
            sumSq = 0;
            filled = 0;
          }
          const runEnd = Math.min(frames, (b + 1) * samplesPerPeak - startFrame);
          filled += runEnd - i;
          for (; i < runEnd; i++) {
            let s = 0;
            for (let c = 0; c < channels; c++) s += scratch[c][i];
            s *= scale;
            if (s < min) min = s;
            if (s > max) max = s;
            sumSq += s * s;
          }
        }
      } finally {
        sample.close();
      }

      if (performance.now() - lastPost > POST_INTERVAL_MS && bucket > postedUpTo) {
        postPeaks(bucket, (bucket * samplesPerPeak) / info!.sampleRate);
      }
    }

    if (!info) {
      return post({ type: 'error', message: 'The audio track contains no samples.', unsupported: false });
    }
    flushBucket();
    // postPeaks transfers slices, not the full arrays, so these are still intact for the cache.
    postPeaks(info.peakCount, info.duration);
    post({ type: 'done', ms: performance.now() - started, fromCache: false });
    await savePeaks(key, info, peaks, energy);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err), unsupported: false });
  }
}

/** Decodes only [start, end) into planar Float32 channels, sample-exact. */
async function readRange(id: number, start: number, end: number) {
  try {
    if (!audioTrack || !decoded) throw new Error('No file is open.');
    const { sampleRate, numberOfChannels } = decoded;
    const length = Math.max(1, Math.round((end - start) * sampleRate));
    const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));

    const sink = new AudioSampleSink(audioTrack);
    for await (const sample of sink.samples(start, end)) {
      try {
        // The first and last samples usually straddle the range edges; copy only the overlap.
        const offset = Math.round((sample.timestamp - start) * sampleRate);
        const from = Math.max(0, -offset);
        const to = Math.min(sample.numberOfFrames, length - offset);
        if (to <= from) continue;
        for (let c = 0; c < Math.min(numberOfChannels, sample.numberOfChannels); c++) {
          sample.copyTo(channels[c].subarray(offset + from, offset + to), {
            planeIndex: c,
            format: 'f32-planar',
            frameOffset: from,
            frameCount: to - from,
          });
        }
      } finally {
        sample.close();
      }
    }
    post({ type: 'range', id, channels, sampleRate }, channels.map((c) => c.buffer));
  } catch (err) {
    post({ type: 'rangeError', id, message: err instanceof Error ? err.message : String(err) });
  }
}
