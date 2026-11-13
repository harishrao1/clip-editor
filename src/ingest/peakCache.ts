/**
 * Waveform peaks cached in the Origin Private File System, so reopening the
 * same file skips decoding entirely. Runs in the ingest worker, where the
 * synchronous access handle API (fast, no promise per write) is available.
 * Every call fails soft: a broken cache must never break opening a file.
 */
import type { MediaInfo } from './protocol';

const DIR = 'peak-cache';
// v2: the .bin holds peak pairs followed by per-bucket energy.
const VERSION = 2;
const MAX_ENTRIES = 12;

type SyncHandle = {
  write(buffer: ArrayBufferView, options?: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
};
type SyncCapableHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> };

export function cacheKey(file: File, samplesPerPeak: number): string {
  // FNV-1a over the identifying fields; OPFS names can't hold arbitrary characters.
  const id = `${VERSION}|${file.name}|${file.size}|${file.lastModified}|${samplesPerPeak}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `p${(h >>> 0).toString(16)}-${file.size.toString(36)}`;
}

async function cacheDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

type Cached = { info: MediaInfo; peaks: Float32Array; energy: Float32Array };

export async function loadPeaks(key: string): Promise<Cached | null> {
  try {
    const dir = await cacheDir();
    const meta = await (await dir.getFileHandle(`${key}.json`)).getFile();
    const data = await (await dir.getFileHandle(`${key}.bin`)).getFile();
    const info = JSON.parse(await meta.text()) as MediaInfo;
    const all = new Float32Array(await data.arrayBuffer());
    const n = info.peakCount;
    if (all.length !== n * 3) return null;
    // Separate copies so each can be transferred to the main thread on its own.
    return { info, peaks: all.slice(0, n * 2), energy: all.slice(n * 2) };
  } catch {
    return null;
  }
}

export async function savePeaks(key: string, info: MediaInfo, peaks: Float32Array, energy: Float32Array): Promise<void> {
  try {
    const dir = await cacheDir();
    const all = new Float32Array(peaks.length + energy.length);
    all.set(peaks);
    all.set(energy, peaks.length);
    // Data first, metadata last: a half-written entry has no .json and is ignored.
    await writeFile(dir, `${key}.bin`, new Uint8Array(all.buffer));
    await writeFile(dir, `${key}.json`, new TextEncoder().encode(JSON.stringify(info)));
    await evictOldest(dir);
  } catch {
    // Quota exceeded or OPFS unavailable: run without a cache.
  }
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array) {
  const handle = (await dir.getFileHandle(name, { create: true })) as SyncCapableHandle;
  const access = await handle.createSyncAccessHandle();
  try {
    access.truncate(0);
    access.write(bytes, { at: 0 });
    access.flush();
  } finally {
    access.close();
  }
}

async function evictOldest(dir: FileSystemDirectoryHandle) {
  const entries: { key: string; modified: number }[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (name.endsWith('.json') && handle.kind === 'file') {
      const file = await (handle as FileSystemFileHandle).getFile();
      entries.push({ key: name.slice(0, -5), modified: file.lastModified });
    }
  }
  entries.sort((a, b) => b.modified - a.modified);
  for (const { key } of entries.slice(MAX_ENTRIES)) {
    await dir.removeEntry(`${key}.json`).catch(() => {});
    await dir.removeEntry(`${key}.bin`).catch(() => {});
  }
}
