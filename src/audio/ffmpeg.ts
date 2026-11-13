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

export async function wavToMp3(
  wav: Blob,
  onProgress: (stage: string, ratio?: number) => void,
): Promise<Blob> {
  onProgress('Loading MP3 encoder');
  const ffmpeg = await getFFmpeg();
  const report = ({ progress }: { progress: number }) => onProgress('Encoding MP3', progress);
  ffmpeg.on('progress', report);
  try {
    await ffmpeg.writeFile('in.wav', await fetchFile(wav));
    await ffmpeg.exec(['-i', 'in.wav', '-codec:a', 'libmp3lame', '-b:a', '192k', 'out.mp3']);
    const data = await ffmpeg.readFile('out.mp3');
    return new Blob([new Uint8Array(data as Uint8Array)], { type: 'audio/mpeg' });
  } finally {
    ffmpeg.off('progress', report);
    // Free the in-memory FS so repeated exports don't accumulate.
    await ffmpeg.deleteFile('in.wav').catch(() => {});
    await ffmpeg.deleteFile('out.mp3').catch(() => {});
  }
}
