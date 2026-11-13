# Clip Editor

A browser-only podcast/audio clip editor. Files never leave the machine: decoding, waveform analysis, trimming, effects and encoding all run client-side. Files are never loaded into memory whole, so multi-hour recordings open in under a second.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173. The header badge shows whether the page is **cross-origin isolated**, which is required for `SharedArrayBuffer` and therefore multi-threaded FFmpeg.wasm.

## How it works

| Stage | API | File |
| --- | --- | --- |
| Ingest | The `File` is read in slices by [Mediabunny](https://mediabunny.dev)'s `BlobSource` inside a worker, never with `file.arrayBuffer()`. Containers (MP4, MOV, WebM, MKV, WAV, MP3, Ogg, FLAC) are demuxed into encoded packets | `src/ingest/ingest.worker.ts` |
| Decode | WebCodecs `AudioDecoder` (via Mediabunny). Each decoded sample is folded into min/max peaks and closed immediately; no whole-file PCM is ever held | `src/ingest/ingest.worker.ts` |
| Waveform | Peaks stream to the main thread every 250 ms as transferred `Float32Array`s; the timeline draws what has arrived and hatches the rest | `src/ingest/client.ts`, `src/components/Timeline.tsx` |
| Peak cache | Finished peaks are written to the Origin Private File System with `createSyncAccessHandle` (worker-only, synchronous). Reopening a file skips decoding entirely. Last 12 files kept | `src/ingest/peakCache.ts` |
| Playback | Files stream from disk through a media element routed into the `AudioContext` (`MediaElementAudioSourceNode` → `AnalyserNode`). The playhead extrapolates from the `AudioContext` clock, re-anchored on seek and on drift > 150 ms | `src/audio/player.ts` |
| Export decode | Only the clip range is decoded (`AudioSampleSink.samples(start, end)`), sample-exact at the edges, so memory scales with the clip, not the file | `src/ingest/ingest.worker.ts` |
| Fallback | If the demuxer can't read a format, the browser's `decodeAudioData` is tried for files up to 300 MB (whole file in memory) | `src/App.tsx` |
| Silence detection | Ingest also records each bucket's mean-square energy. Detection runs on 20 ms RMS windows: below threshold for at least the minimum gap, with blips under 120 ms bridged and padding left around speech. The threshold defaults to one derived from the file's own 10th/90th level percentiles. Results grow as a long file is analysed | `src/audio/silence.ts` |
| Video preview | A second worker demuxes the video track and decodes it with WebCodecs `VideoDecoder` (via Mediabunny's `VideoSampleSink`), drawing into an `OffscreenCanvas` handed over with `transferControlToOffscreen()`. Paused seeks fetch the exact frame; playback iterates with look-ahead | `src/video/video.worker.ts` |
| Shared clock | The main thread writes the playhead into a `SharedArrayBuffer` every animation frame; the video worker reads it with no message traffic (falls back to `postMessage` when the page isn't cross-origin isolated) | `src/video/client.ts`, `src/components/VideoPanel.tsx` |
| Frame lifetime | Decoded frames sit in a small fixed pool of decoder/GPU buffers. Each frame is closed the moment it has been drawn (the canvas keeps the pixels), so at most one decoded frame is held. Holding more can exhaust the pool and deadlock the decoder. The panel shows drawn / dropped / open frame counts | `src/video/video.worker.ts` |
| Video export | A third worker decodes only the kept segments, draws each frame at display size, crops and scales it on an `OffscreenCanvas` (9:16 → 1080×1920, 1:1 → 1080×1080, or the original frame), and encodes H.264 with WebCodecs `VideoEncoder`. The soundtrack (trim, silence cuts, gain, fades) is rendered once on the main thread and encoded to AAC. Frames are re-timed onto a constant-frame-rate grid so splices never produce duplicate timestamps | `src/video/export.worker.ts` |
| Export target | Mediabunny's `StreamTarget` emits positioned writes, which an OPFS `FileSystemWritableFileStream` accepts directly, so the MP4 is muxed straight to disk instead of being assembled in memory. Cancel terminates the worker; an unclosed OPFS writable never commits, so nothing large is left behind | `src/video/export.worker.ts`, `src/video/export.ts` |
| Cut list | Removed ranges inside the clip. Playback jumps over them; export decodes only the kept segments and joins them with 4 ms micro-fades so cuts don't click | `src/App.tsx`, `src/audio/render.ts`, `src/audio/player.ts` |
| Timeline | Canvas 2D. Waveform cached in an offscreen layer and re-rendered only on view/trim/peaks change; each frame blits it and draws the playhead | `src/components/Timeline.tsx` |
| Visualizer | `AnalyserNode.getByteFrequencyData`, log-spaced bars | `src/components/Visualizer.tsx` |
| Render | `OfflineAudioContext` with gain automation for fades, faster than real time | `src/audio/render.ts` |
| Encode | WAV written by hand; MP3 via FFmpeg.wasm (lazy-loaded, multi-threaded core when isolated) | `src/audio/ffmpeg.ts` |

### Cross-origin isolation

`vite.config.ts` (dev/preview) and `vercel.json` (production) send:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Any third-party resource the page loads must then be CORS-enabled or send `Cross-Origin-Resource-Policy`.

## Controls

- Drag the bracket handles to set the clip start and end, or type exact times into the Start and End fields
- Click or drag elsewhere on the waveform to move the playhead; drag the box in the overview strip to pan
- Scroll to pan, Ctrl/⌘ + scroll to zoom around the pointer
- Press `?` in the app for the full list of keyboard shortcuts

## Design

The visual direction is "Studio light": white cards on a soft grey frame with one calm blue accent; cuts use a separate red so removed never reads as selected. Light is the default, and a matching dark mode is one click away in the top bar (the choice is remembered). Canvas colours are read from CSS custom properties (`--tl-*`, `--viz-*` in `src/App.css`), so both canvases follow the theme. Type is Geist Sans and Geist Mono, self-hosted via `@fontsource` so the cross-origin isolation headers don't block them. On desktop the editor fills the window: stage, timeline dock and inspector are floating panels on the window frame, and only the inspector scrolls.

## Measurements

Chrome, Windows, one 948 MB MP4 (2 h 55 min, AAC 48 kHz stereo + 710×296 H.264):

| | Result |
| --- | --- |
| Time until the editor is usable | ~0.5 s (container parsed, first audio decoded) |
| Full waveform analysis | 40.0 s (~263× real time), off the main thread |
| Main-thread JS heap, peak | 76 MB (worker heap not included; `measureUserAgentSpecificMemory` was unavailable in the test browser) |
| What the old `arrayBuffer()` + `decodeAudioData` path would need | ~0.95 GB file buffer + ~2.0 GB Float32 PCM |
| Reopen the same file | ~0.3 s, full waveform from the OPFS cache |
| Export 30 s from 1:30:00 as WAV | 252 ms; output exactly 30.000 s (5,760,044 bytes) |

Also checked: MP3 (2:26, analysed in 0.9 s), MKV with AAC + 1080p H.264 (plays and analyses), and a non-media file (clear error, no stuck state).

Video preview on the same film (710×296 H.264, 24 fps): seeking to any point while paused takes 16–150 ms, including decoding from the previous keyframe. Real playback drew 92 frames and dropped 5 in 4 s (≈24 fps), with never more than 1 decoded frame alive and 0 after pausing. A 1080p H.264 MKV played at a steady 30 fps.

9:16 export, checked by decoding the output again:

| Clip | Result |
| --- | --- |
| 15 s of a 1080p MKV, crop moved off-centre | 451 frames in 9.2 s. MP4, H.264 High (`avc1.640028`) 1080×1920 + AAC-LC 48 kHz, 15.019 s. Output frames match the source at the chosen crop (mean difference 0.6/255) and not the centre crop (92/255) |
| 2:30 of the film with 3 silence cuts (2:24 output) | 3,456 frames, exactly 41.7 ms apart, 0 duplicate timestamps. A frame after all three cuts matches the source 6.0 s later (0.6/255). Encoding took 42–108 s across runs; the slower runs were with the app window not in view |

Silence detection on the same film found 309 gaps (12.9 min) at an auto threshold of −41 dB. On 3 hours of data, recomputing window levels takes ~17 ms per data update; moving a silence slider re-runs only the scan, ~4.5 ms. A sample export with three cuts came out exactly as long as the UI said (41.533 s).

## Roadmap

- [x] **Streaming ingest**: demux + WebCodecs decode in a worker, progressive peaks, OPFS peak cache, disk-streamed playback, range-only export decode
- [x] **Silence detection**: RMS scan during ingest, auto threshold, clickable silence lane, multi-segment cut list, skip-on-playback, click-free export
- [ ] **Manual cuts**: cut any selected range, not only detected silences; undo/redo for the cut list
- [ ] **Streaming export**: encode segment by segment instead of rendering the whole output in memory (lifts the 60-minute export limit)
- [x] **Video preview**: `VideoDecoder` → `OffscreenCanvas` in a media worker, shared-memory clock, at most one live frame
- [ ] **Timeline thumbnails**: a strip of video frames above the waveform
- [x] **9:16 export**: draggable crop, `VideoEncoder` H.264 + AAC, MP4 muxed straight to OPFS, cancel
- [ ] **Captions**: burn-in text overlays during export
- [ ] **Keyframed crop**: let the frame follow the speaker over time instead of a single position
- [ ] **WebCodecs audio encode**: `AudioEncoder` (AAC/Opus) as the fast path instead of FFmpeg.wasm for MP3
- [ ] **Peak mipmaps**: several bucket sizes so the zoomed-out view of a 3-hour file is O(width) per redraw
- [ ] **WAV encode in a worker** so long exports don't block the UI
- [ ] **Benchmarks** in a browser that exposes `measureUserAgentSpecificMemory`, to include worker memory
