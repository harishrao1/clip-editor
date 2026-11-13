/** "m:ss.cc", or "h:mm:ss.cc" from an hour up. */
export function formatTime(seconds: number, showMs = true): string {
  // Work in whole centiseconds so 59.996 becomes 1:00.00, not 0:60.00.
  const cs = showMs ? Math.round(Math.max(0, seconds) * 100) : Math.floor(Math.max(0, seconds)) * 100;
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const frac = showMs ? `.${String(cs % 100).padStart(2, '0')}` : '';
  const tail = `${String(s).padStart(2, '0')}${frac}`;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${tail}` : `${m}:${tail}`;
}

/** Parses "ss.cc", "m:ss.cc" or "h:mm:ss.cc". Returns null for anything else. */
export function parseTime(input: string): number | null {
  const parts = input.trim().split(':');
  if (parts.length > 3 || parts.some((p) => p.trim() === '' || !Number.isFinite(Number(p)))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
