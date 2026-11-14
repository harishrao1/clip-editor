import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const CORE_VERSION = '0.12.10';
let instance: Promise<FFmpeg> | null = null;

/** Loads FFmpeg.wasm once (~30 MB). Uses the multi-threaded core when SharedArrayBuffer is available. */
function getFFmpeg(): Promise<FFmpeg> {
  instance ??= (async () => {
    const ffmpeg = new FFmpeg();
    const mt = self.crossOriginIsolated;
    const pkg = mt ? '@ffmpeg/core-mt' : '@ffmpeg/core';
    const base = `https://cdn.jsdelivr.net/npm/${pkg}@${CORE_VERSION}/dist/esm`;
    await ffmpeg.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
      workerURL: mt
        ? await toBlobURL(`${base}/ffmpeg-core.worker.js`, 'text/javascript')
        : undefined,
    });
    return ffmpeg;
  })().catch((err) => {
    instance = null;
    throw err;
  });
  return instance;
}

/**
 * FFmpeg.wasm's 'progress' event stays at 0 for WAV input (no duration in its estimate),
 * so progress is read from the encoder's own "time=hh:mm:ss.cc" log lines instead.
 */
export async function wavToMp3(
  wav: Blob,
  durationSec: number,
  onProgress: (stage: string, ratio?: number) => void,
): Promise<Blob> {
  onProgress('Loading MP3 encoder');
  const ffmpeg = await getFFmpeg();
  onProgress('Encoding MP3', 0);
  const report = ({ message }: { message: string }) => {
    const m = /time=s*(d+):(d+):(d+(?:.d+)?)/.exec(message);
    if (!m || durationSec <= 0) return;
    const t = +m[1] * 3600 + +m[2] * 60 + +m[3];
    onProgress('Encoding MP3', Math.min(1, t / durationSec));
  };
  ffmpeg.on('log', report);
  try {
    await ffmpeg.writeFile('in.wav', await fetchFile(wav));
    await ffmpeg.exec(['-i', 'in.wav', '-codec:a', 'libmp3lame', '-b:a', '192k', 'out.mp3']);
    const data = await ffmpeg.readFile('out.mp3');
    return new Blob([new Uint8Array(data as Uint8Array)], { type: 'audio/mpeg' });
  } finally {
    ffmpeg.off('log', report);
    // Free the in-memory FS so repeated exports don't accumulate.
    await ffmpeg.deleteFile('in.wav').catch(() => {});
    await ffmpeg.deleteFile('out.mp3').catch(() => {});
  }
}
