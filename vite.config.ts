import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SharedArrayBuffer (needed by multi-threaded FFmpeg.wasm) only exists when the
// page is cross-origin isolated, which requires these two headers.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: { headers: isolation },
  preview: { headers: isolation },
  // @ffmpeg/ffmpeg spawns its own worker via new URL(); pre-bundling breaks that.
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
  worker: { format: 'es' },
});
