/**
 * Timeline thumbnail worker. Decodes single frames on request and returns them
 * as small ImageBitmaps (transferred, not copied). The newest request list
 * replaces the queue, so scrolling never leaves a backlog of stale tiles.
 */
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny';

type Request = { key: string; time: number };
type ToWorker = { type: 'open'; file: File; height: number } | { type: 'want'; requests: Request[] };

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

let sink: VideoSampleSink | null = null;
let size = { width: 0, height: 0 };
let queue: Request[] = [];
let running = false;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'open') void open(msg.file, msg.height);
  else {
    queue = msg.requests;
    void pump();
  }
};

async function open(file: File, height: number) {
  try {
    const track = await new Input({ source: new BlobSource(file), formats: ALL_FORMATS }).getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return post({ type: 'unavailable' });
    const aspect = track.displayWidth / track.displayHeight;
    size = { width: Math.round(height * aspect), height };
    sink = new VideoSampleSink(track);
    post({ type: 'ready', aspect });
    void pump();
  } catch {
    post({ type: 'unavailable' });
  }
}

async function pump() {
  if (running || !sink) return;
  running = true;
  try {
    while (queue.length) {
      const { key, time } = queue.shift()!;
      const sample = await sink.getSample(time);
      if (!sample) continue;
      const canvas = new OffscreenCanvas(size.width, size.height);
      sample.drawWithFit(canvas.getContext('2d')!, { fit: 'cover' });
      sample.close();
      const bitmap = canvas.transferToImageBitmap();
      post({ type: 'thumb', key, bitmap }, [bitmap]);
    }
  } finally {
    running = false;
  }
}
