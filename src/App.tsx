import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import { Player } from './audio/player';
import { computePeaks } from './audio/peaks';
import { encodeWav, renderClip, type Piece } from './audio/render';
import {
  clampRanges,
  detectSilences,
  keptSegments,
  overlaps,
  suggestThreshold,
  windowLevels,
  totalLength,
  type Range,
} from './audio/silence';
import { createSampleBuffer } from './audio/sample';
import { Timeline, type TimelineHandle } from './components/Timeline';
import { VideoPanel } from './components/VideoPanel';
import { Visualizer } from './components/Visualizer';
import {
  AlertIcon,
  BackIcon,
  CheckIcon,
  CloseIcon,
  DownloadIcon,
  FolderIcon,
  ForwardIcon,
  KeyboardIcon,
  LogoMark,
  LoopIcon,
  MinusIcon,
  MoonIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SunIcon,
  ToEndIcon,
  ToStartIcon,
  UploadIcon,
} from './components/Icons';
import { Ingest } from './ingest/client';
import { cropRect, FRAMES, outputSize, type CropCenter, type FrameId } from './video/crop';
import { Filmstrip } from './video/filmstrip';
import { ExportCancelled, exportVideo } from './video/export';
import type { MediaInfo } from './ingest/protocol';
import { useTheme } from './theme';
import { formatBytes, formatTime, parseTime } from './time';

const SAMPLES_PER_PEAK = 128;
const MP3_KBPS = 192;
const MIN_CLIP = 0.05;
/** The fallback decoder needs the whole file plus its decoded PCM in memory, so cap it. */
const FALLBACK_DECODE_LIMIT = 300 * 1024 * 1024;
/** Export renders the whole output in an OfflineAudioContext; past this it risks running out of memory. */
const MAX_EXPORT_SEC = 60 * 60;

type Clip = {
  name: string;
  duration: number;
  sampleRate: number;
  numberOfChannels: number;
  /** Filled in progressively while a file is analysed; same array identity throughout. */
  peaks: Float32Array;
  /** Mean square per peak bucket, for silence detection. Filled alongside `peaks`. */
  energy: Float32Array;
  peaksVersion: number;
  analysedUntil: number;
  /** Where playback and export read audio from. */
  source: { kind: 'memory'; buffer: AudioBuffer } | { kind: 'file'; ingest: Ingest };
  /** The file's video track, if any; drives the preview panel. */
  video: MediaInfo['video'];
  /** Status bar details, e.g. "MP4 · aac" or "Video 1920×1080 avc". */
  details: string[];
  memoryNote: string;
  /** How the waveform was obtained ("Analysed in 2.1 s", "Waveform loaded from cache"). */
  sourceNote: string;
};
type Format = 'mp4' | 'wav' | 'mp3';
type Busy = { stage: string; ratio?: number };
type Toast = { kind: 'success' | 'error'; title: string; detail?: string };

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [player] = useState(() => new Player());
  const [clip, setClip] = useState<Clip | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [trim, setTrim] = useState({ start: 0, end: 0 });
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [gainDb, setGainDb] = useState(0);
  const [fadeIn, setFadeIn] = useState(0);
  const [fadeOut, setFadeOut] = useState(0);
  const [format, setFormat] = useState<Format>('wav');
  const [busy, setBusy] = useState<Busy | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Silence detection. The threshold follows the recording's own levels until the user moves it.
  const [thresholdAuto, setThresholdAuto] = useState(true);
  const [manualThreshold, setManualThreshold] = useState(-45);
  const [minGap, setMinGap] = useState(1.5);
  const [padding, setPadding] = useState(0.2);
  const [cuts, setCuts] = useState<Range[]>([]);
  // Video export framing.
  const [frame, setFrame] = useState<FrameId>('portrait');
  const [cropCenter, setCropCenter] = useState<CropCenter>({ x: 0.5, y: 0.5 });
  const exportRun = useRef<{ cancel: () => void } | null>(null);
  const [filmstrip, setFilmstrip] = useState<Filmstrip | null>(null);
  const videoFile = clip?.source.kind === 'file' && clip.video ? clip.source.ingest.file : null;

  // One thumbnail worker per open video file.
  useEffect(() => {
    if (!videoFile) {
      setFilmstrip(null);
      return;
    }
    const strip = new Filmstrip(videoFile, 42);
    setFilmstrip(strip);
    return () => strip.dispose();
  }, [videoFile]);

  const timeline = useRef<TimelineHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const shortcutsDialog = useRef<HTMLDialogElement>(null);
  const ingestRef = useRef<Ingest | null>(null);

  const bucketSec = clip ? SAMPLES_PER_PEAK / clip.sampleRate : 1;
  const analysedBuckets = clip ? Math.floor(clip.analysedUntil / bucketSec) : 0;
  const levels = useMemo(
    () => windowLevels(clip?.energy ?? new Float32Array(0), bucketSec, analysedBuckets),
    // peaksVersion: energy is filled in place while a file is analysed.
    [clip?.energy, clip?.peaksVersion, analysedBuckets, bucketSec],
  );
  const suggestedThreshold = useMemo(() => suggestThreshold(levels), [levels]);
  const threshold = thresholdAuto ? suggestedThreshold : manualThreshold;
  const silences = useMemo(
    () => clampRanges(detectSilences(levels, { thresholdDb: threshold, minDuration: minGap, padding }), trim),
    [levels, threshold, minGap, padding, trim],
  );
  const cutsInClip = useMemo(() => clampRanges(cuts, trim), [cuts, trim]);
  const segments = useMemo(() => keptSegments(trim, cuts), [trim, cuts]);
  const clipLength = trim.end - trim.start;
  const outputLength = totalLength(segments);
  // Playback stops at the end of the last kept segment, so a trailing cut isn't played.
  const playEnd = segments.length ? segments[segments.length - 1].end : trim.end;

  const trimRef = useRef(trim);
  trimRef.current = trim;
  const playEndRef = useRef(playEnd);
  playEndRef.current = playEnd;
  const loopRef = useRef(loop);
  loopRef.current = loop;

  useEffect(() => player.setSkips(cutsInClip), [player, cutsInClip]);

  useEffect(() => {
    player.onEnded = () => {
      if (loopRef.current) void player.play(trimRef.current.start, playEndRef.current);
      else setPlaying(false);
    };
    player.onError = (message) => {
      setPlaying(false);
      setToast({ kind: 'error', title: "Playback isn't available", detail: message });
    };
  }, [player]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  function resetForNewFile() {
    player.unload();
    ingestRef.current?.dispose();
    ingestRef.current = null;
    setPlaying(false);
    setClip(null);
    setCuts([]);
    setThresholdAuto(true);
    setCropCenter({ x: 0.5, y: 0.5 });
    window.scrollTo(0, 0);
  }

  /** For audio that is already decoded in memory: the sample, and the fallback path. */
  async function openBuffer(name: string, buffer: AudioBuffer, sourceNote: string, details: string[] = []) {
    setLoading('Drawing the waveform');
    const { peaks, energy } = await computePeaks(buffer, SAMPLES_PER_PEAK);
    player.loadBuffer(buffer);
    setClip({
      name,
      duration: buffer.duration,
      sampleRate: buffer.sampleRate,
      numberOfChannels: buffer.numberOfChannels,
      peaks,
      energy,
      peaksVersion: 0,
      analysedUntil: buffer.duration,
      source: { kind: 'memory', buffer },
      video: null,
      details,
      memoryNote: `${formatBytes(buffer.length * buffer.numberOfChannels * 4)} audio in memory`,
      sourceNote,
    });
    setTrim({ start: 0, end: buffer.duration });
    setFormat((f) => (f === 'mp4' ? 'wav' : f));
    setLoading(null);
  }

  /**
   * Opens a file without loading it into memory. The ingest worker demuxes and
   * decodes it in pieces and streams the waveform back; playback streams from
   * disk; export decodes only the clip range.
   */
  function openFile(file: File) {
    resetForNewFile();
    setLoading(`Reading ${file.name}`);
    let peaks = new Float32Array(0);
    let energy = new Float32Array(0);
    let opened = false;

    const ingest = new Ingest(file, SAMPLES_PER_PEAK, {
      onInfo(info, fromCache) {
        opened = true;
        peaks = new Float32Array(info.peakCount * 2);
        energy = new Float32Array(info.peakCount);
        player.loadFile(file);
        setClip({
          name: file.name,
          duration: info.duration,
          sampleRate: info.sampleRate,
          numberOfChannels: info.numberOfChannels,
          peaks,
          energy,
          peaksVersion: 0,
          analysedUntil: 0,
          source: { kind: 'file', ingest },
          video: info.video,
          details: describeMedia(info),
          memoryNote: `${formatBytes(peaks.byteLength + energy.byteLength)} waveform data · audio read from disk`,
          sourceNote: fromCache ? 'Waveform loaded from cache' : 'Analysing',
        });
        setTrim({ start: 0, end: info.duration });
        // Video files default to video export; audio files can't use it.
        setFormat((f) => (info.video ? 'mp4' : f === 'mp4' ? 'wav' : f));
        setLoading(null);
      },
      onPeaks(offset, data, e, analysedUntil) {
        peaks.set(data, offset * 2);
        energy.set(e, offset);
        setClip((c) => (c?.peaks === peaks ? { ...c, peaksVersion: c.peaksVersion + 1, analysedUntil } : c));
      },
      onDone(ms, fromCache) {
        setClip((c) =>
          c?.peaks === peaks
            ? {
                ...c,
                analysedUntil: c.duration,
                sourceNote: fromCache ? 'Waveform loaded from cache' : `Analysed in ${(ms / 1000).toFixed(1)} s`,
              }
            : c,
        );
      },
      onError(message, unsupported) {
        if (opened) {
          setToast({ kind: 'error', title: 'Waveform analysis stopped', detail: message });
          return;
        }
        ingest.dispose();
        ingestRef.current = null;
        void openWithFallback(file, message, unsupported);
      },
    });
    ingestRef.current = ingest;
  }

  /** The browser's built-in decoder handles a few formats the demuxer doesn't, but only whole files in memory. */
  async function openWithFallback(file: File, reason: string, unsupported: boolean) {
    const fail = (detail: string) => {
      setLoading(null);
      setToast({ kind: 'error', title: `Couldn't open ${file.name}`, detail });
    };
    if (!unsupported) return fail(reason);
    if (file.size > FALLBACK_DECODE_LIMIT) {
      return fail(`${reason} The browser's fallback decoder can only take files up to ${formatBytes(FALLBACK_DECODE_LIMIT)}.`);
    }
    try {
      setLoading(`Decoding ${file.name}`);
      const t0 = performance.now();
      const buffer = await player.ctx.decodeAudioData(await file.arrayBuffer());
      await openBuffer(file.name, buffer, `Decoded in ${Math.round(performance.now() - t0)} ms`, ['Fallback decoder']);
    } catch {
      fail(`${reason} Try WAV, MP3, M4A or MP4.`);
    }
  }

  async function openSample() {
    resetForNewFile();
    setLoading('Generating the sample');
    // Let the loading state paint before the synchronous synthesis runs.
    await new Promise((r) => setTimeout(r, 30));
    await openBuffer('sample-recording.wav', createSampleBuffer(player.ctx), 'Generated sample');
  }

  async function togglePlay() {
    if (!clip) return;
    if (player.playing) {
      player.pause();
      setPlaying(false);
      return;
    }
    const { start } = trimRef.current;
    const end = playEndRef.current;
    const pos = player.position;
    const from = pos >= start && pos < end - 0.01 ? pos : start;
    await player.play(from, end);
    setPlaying(true);
  }

  function seek(t: number) {
    if (!clip) return;
    player.seek(Math.min(clip.duration, Math.max(0, t)), playEndRef.current);
  }

  /** Cut a detected silence, or restore it if any part of it is already cut. */
  function toggleSilence(range: Range) {
    setCuts((cs) =>
      cs.some((c) => overlaps(c, range)) ? cs.filter((c) => !overlaps(c, range)) : [...cs, range].sort((a, b) => a.start - b.start),
    );
  }

  function cutAllSilences() {
    setCuts((cs) => [...cs, ...silences.filter((s) => !cs.some((c) => overlaps(c, s)))].sort((a, b) => a.start - b.start));
  }

  const setStart = (t: number) => setTrim((tr) => ({ start: Math.max(0, Math.min(t, tr.end - MIN_CLIP)), end: tr.end }));
  const setEnd = (t: number) =>
    setTrim((tr) => ({ start: tr.start, end: Math.min(clip?.duration ?? t, Math.max(t, tr.start + MIN_CLIP)) }));

  // Keyboard shortcuts. Re-bound every render so handlers see current state.
  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '?' || (e.code === 'Slash' && e.shiftKey)) {
        e.preventDefault();
        shortcutsDialog.current?.showModal();
        return;
      }
      if (!clip || shortcutsDialog.current?.open) return;
      const step = e.shiftKey ? 5 : 1;
      const actions: Record<string, () => void> = {
        Space: () => void togglePlay(),
        KeyI: () => setStart(player.position),
        KeyO: () => setEnd(player.position),
        KeyL: () => setLoop((l) => !l),
        Home: () => seek(trimRef.current.start),
        End: () => seek(trimRef.current.end),
        ArrowLeft: () => seek(player.position - step),
        ArrowRight: () => seek(player.position + step),
        Equal: () => timeline.current?.zoomBy(1.5),
        NumpadAdd: () => timeline.current?.zoomBy(1.5),
        Minus: () => timeline.current?.zoomBy(1 / 1.5),
        NumpadSubtract: () => timeline.current?.zoomBy(1 / 1.5),
        Digit0: () => timeline.current?.fit(),
      };
      const action = actions[e.code];
      if (!action) return;
      // Space always means play/pause, even when a button has focus.
      e.preventDefault();
      action();
    };
    // A focused button "clicks" on Space keyup; cancel that so Space doesn't do two things.
    const onKeyUp = (e: KeyboardEvent) => {
      if (clip && e.code === 'Space' && e.target instanceof HTMLButtonElement) e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  });

  async function exportClip() {
    if (!clip || busy) return;
    if (outputLength > MAX_EXPORT_SEC) {
      setToast({
        kind: 'error',
        title: 'This clip is too long to export',
        detail: `Exports are rendered in memory, so they're limited to ${MAX_EXPORT_SEC / 60} minutes for now. This one is ${formatTime(outputLength)}.`,
      });
      return;
    }
    const baseName = clip.name.replace(/\.[^.]+$/, '');
    try {
      if (format === 'mp4') {
        await exportVideoClip(baseName);
        return;
      }
      // Audio-only progress uses the whole bar; 0.4 is where WAV writing starts.
      const rendered = await renderSoundtrack(0.4);
      setBusy({ stage: 'Writing WAV', ratio: 0.4 });
      let blob = encodeWav(rendered);
      if (format === 'mp3') {
        // Loaded on demand so the 30 MB encoder is only downloaded when someone needs it.
        const { wavToMp3 } = await import('./audio/ffmpeg');
        blob = await wavToMp3(blob, (stage, ratio) =>
          setBusy({ stage, ratio: ratio === undefined ? 0.5 : 0.5 + ratio * 0.5 }),
        );
      }
      const filename = `${baseName}-clip.${format}`;
      download(blob, filename);
      setToast({ kind: 'success', title: 'Clip saved', detail: `${filename} · ${formatBytes(blob.size)}` });
    } catch (err) {
      if (err instanceof ExportCancelled) {
        setToast({ kind: 'success', title: 'Export cancelled' });
        return;
      }
      setToast({
        kind: 'error',
        title: "Export didn't finish",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      exportRun.current = null;
      setBusy(null);
    }
  }

  /**
   * The clip's audio exactly as it plays: kept segments joined, gain and fades
   * applied. Only the kept segments are decoded, so memory scales with the
   * output, not the file. Progress runs from 0 to `upTo`.
   */
  async function renderSoundtrack(upTo: number): Promise<AudioBuffer> {
    const source = clip!.source;
    let pieces: Piece[];
    if (source.kind === 'file') {
      pieces = [];
      for (const [i, s] of segments.entries()) {
        const stage = segments.length > 1 ? `Decoding audio, part ${i + 1} of ${segments.length}` : 'Decoding audio';
        setBusy({ stage, ratio: (upTo * 0.6 * i) / segments.length });
        const buffer = await source.ingest.readRange(s.start, s.end);
        pieces.push({ buffer, start: 0, end: buffer.duration });
      }
    } else {
      pieces = segments.map((s) => ({ buffer: source.buffer, start: s.start, end: s.end }));
    }
    setBusy({ stage: 'Rendering audio', ratio: upTo * 0.75 });
    return renderClip(pieces, { gain: dbToGain(gainDb), fadeIn, fadeOut });
  }

  /** MP4 export: soundtrack rendered here, video decoded, cropped and encoded in a worker. */
  async function exportVideoClip(baseName: string) {
    const source = clip!.source;
    const video = clip!.video;
    if (source.kind !== 'file' || !video) throw new Error('This file has no video track to export.');
    const started = performance.now();
    const soundtrack = await renderSoundtrack(0.15);
    const channels = Array.from({ length: soundtrack.numberOfChannels }, (_, c) => soundtrack.getChannelData(c).slice());
    const suffix = frame === 'portrait' ? '9x16' : frame === 'square' ? '1x1' : 'clip';
    const fileName = `${baseName}-${suffix}.mp4`;

    const run = exportVideo(
      {
        file: source.ingest.file,
        segments,
        crop: cropRect(video.width, video.height, FRAMES[frame].aspect, cropCenter),
        output: outputSize(frame, video.width, video.height),
        audio: { channels, sampleRate: soundtrack.sampleRate },
        fileName,
      },
      (stage, ratio) => setBusy({ stage, ratio: 0.15 + ratio * 0.85 }),
    );
    exportRun.current = run;
    const result = await run.promise;
    download(result.file, fileName);
    setToast({
      kind: 'success',
      title: 'Video saved',
      detail: `${fileName} · ${formatBytes(result.file.size)} · ${result.frames.toLocaleString()} frames in ${((performance.now() - started) / 1000).toFixed(1)} s`,
    });
  }

  const onFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (file) void openFile(file);
  };

  const videoOut = clip?.video ? outputSize(frame, clip.video.width, clip.video.height) : null;
  const videoCrop = clip?.video ? cropRect(clip.video.width, clip.video.height, FRAMES[frame].aspect, cropCenter) : null;
  // How much the crop gets enlarged. A 1080p 16:9 → 9:16 crop is ~1.8×, which is normal; past 2× it looks soft.
  const upscale = videoOut && videoCrop ? videoOut.height / videoCrop.height : 1;
  const estimate = !clip
    ? 0
    : format === 'wav'
      ? outputLength * clip.sampleRate * clip.numberOfChannels * 2 + 44
      : format === 'mp3'
        ? (outputLength * MP3_KBPS * 1000) / 8
        : // Rough H.264 rate at high quality (~4 Mbps per 1080p-worth of pixels) plus 160 kbps audio.
          (outputLength * ((videoOut ? (videoOut.width * videoOut.height) / (1920 * 1080) : 1) * 4_000_000 + 160_000)) / 8;
  const removed = clipLength - outputLength;

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        onFiles(e.dataTransfer.files);
      }}
    >
      <input
        ref={fileInput}
        type="file"
        accept="audio/*,video/*"
        hidden
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = '';
        }}
      />

      <header className="topbar">
        <div className="brand">
          <LogoMark />
          <span>Clip Editor</span>
        </div>
        {clip && (
          <div className="doc">
            <span className="doc-name" title={clip.name}>
              {clip.name}
            </span>
            <button className="btn btn-quiet btn-sm" onClick={() => fileInput.current?.click()}>
              <FolderIcon size={15} />
              Open another file
            </button>
          </div>
        )}
        <div className="topbar-actions">
          <IconButton label="Keyboard shortcuts (?)" onClick={() => shortcutsDialog.current?.showModal()}>
            <KeyboardIcon />
          </IconButton>
          <IconButton label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggleTheme}>
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </IconButton>
        </div>
      </header>

      {!clip ? (
        <OpenScreen
          loading={loading}
          dragOver={dragOver}
          onBrowse={() => fileInput.current?.click()}
          onSample={openSample}
        />
      ) : (
        <div className="shell">
          <main className="stage" aria-label="Preview">
            {clip.source.kind === 'file' && clip.video ? (
              <VideoPanel
                key={clip.name}
                file={clip.source.ingest.file}
                player={player}
                // The crop box only matters when exporting video.
                frame={format === 'mp4' ? frame : 'original'}
                crop={cropCenter}
                onCropChange={setCropCenter}
              />
            ) : (
              <AudioStage analyser={player.analyser} theme={theme} name={clip.name} details={[channelName(clip.numberOfChannels), `${(clip.sampleRate / 1000).toFixed(1)} kHz`, ...clip.details]} />
            )}
          </main>

          <section className="dock" aria-label="Timeline">
            <div className="dock-bar">
              <Clock player={player} duration={clip.duration} />
              <div className="transport-buttons">
                <IconButton label="Go to clip start (Home)" onClick={() => seek(trim.start)}>
                  <ToStartIcon />
                </IconButton>
                <IconButton label="Back 5 seconds (Shift + ←)" onClick={() => seek(player.position - 5)}>
                  <BackIcon />
                </IconButton>
                <button
                  className="play-btn"
                  onClick={togglePlay}
                  aria-label={playing ? 'Pause (Space)' : 'Play (Space)'}
                  title={playing ? 'Pause (Space)' : 'Play (Space)'}
                >
                  {playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
                </button>
                <IconButton label="Forward 5 seconds (Shift + →)" onClick={() => seek(player.position + 5)}>
                  <ForwardIcon />
                </IconButton>
                <IconButton label="Go to clip end (End)" onClick={() => seek(trim.end)}>
                  <ToEndIcon />
                </IconButton>
              </div>
              <div className="transport-edit">
                <button className="btn btn-outline btn-sm" onClick={() => setStart(player.position)} title="Set the clip start at the playhead (I)">
                  Set start <kbd>I</kbd>
                </button>
                <button className="btn btn-outline btn-sm" onClick={() => setEnd(player.position)} title="Set the clip end at the playhead (O)">
                  Set end <kbd>O</kbd>
                </button>
                <IconButton label="Loop the clip (L)" active={loop} onClick={() => setLoop((l) => !l)}>
                  <LoopIcon />
                </IconButton>
              </div>
            </div>

            <Timeline
              ref={timeline}
              theme={theme}
              peaks={clip.peaks}
              peaksVersion={clip.peaksVersion}
              analysedUntil={clip.analysedUntil}
              samplesPerPeak={SAMPLES_PER_PEAK}
              sampleRate={clip.sampleRate}
              duration={clip.duration}
              trimStart={trim.start}
              trimEnd={trim.end}
              getPosition={() => player.position}
              isPlaying={() => player.playing}
              onSeek={seek}
              onTrimChange={(start, end) => setTrim({ start, end })}
              onZoomChange={setZoom}
              silences={silences}
              cuts={cutsInClip}
              onToggleSilence={toggleSilence}
              filmstrip={filmstrip}
            />


            <div className="dock-bar dock-bar-sub">
              <div className="tool-group fields" role="group" aria-label="Clip range">
                <TimeField label="Start" value={trim.start} onCommit={setStart} />
                <TimeField label="End" value={trim.end} onCommit={setEnd} />
                <div
                  className="field field-readonly"
                  title={removed > 0 ? `${formatTime(clipLength)} between start and end, minus ${removed.toFixed(1)} s of cuts` : undefined}
                >
                  <span className="field-label">Length</span>
                  <span className="field-value">{formatTime(outputLength)}</span>
                </div>
              </div>
              <div className="tool-group" role="group" aria-label="Zoom">
                <IconButton label="Zoom out (−)" onClick={() => timeline.current?.zoomBy(1 / 1.5)}>
                  <MinusIcon />
                </IconButton>
                <span className="zoom-level" aria-live="polite">
                  {zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}×
                </span>
                <IconButton label="Zoom in (+)" onClick={() => timeline.current?.zoomBy(1.5)}>
                  <PlusIcon />
                </IconButton>
                <span className="sep" />
                <button className="btn btn-quiet btn-sm" onClick={() => timeline.current?.fit()} title="Show the whole file (0)">
                  Show all
                </button>
                <button className="btn btn-quiet btn-sm" onClick={() => timeline.current?.zoomToSelection()}>
                  Fit clip
                </button>
              </div>
            </div>
          </section>

          <aside className="inspector" aria-label="Clip settings">
            <div className="inspector-scroll">
              <section className="inspector-section">
                <div className="section-head">
                  <h2>Format</h2>
                </div>
                <div className="segmented" role="radiogroup" aria-label="File format">
                  {(clip.video ? (['mp4', 'wav', 'mp3'] as const) : (['wav', 'mp3'] as const)).map((f) => (
                    <button
                      key={f}
                      role="radio"
                      aria-checked={format === f}
                      className={format === f ? 'is-selected' : ''}
                      onClick={() => setFormat(f)}
                    >
                      {FORMAT_INFO[f].label}
                    </button>
                  ))}
                </div>
                <p className="note">{FORMAT_INFO[format].text}</p>
                {format === 'mp4' && videoOut && videoCrop && (
                  <div className="frame-picker">
                    <div className="frame-options" role="radiogroup" aria-label="Frame">
                      {(Object.keys(FRAMES) as FrameId[]).map((id) => (
                        <button
                          key={id}
                          role="radio"
                          aria-checked={frame === id}
                          className={`frame-option ${frame === id ? 'is-selected' : ''}`}
                          onClick={() => setFrame(id)}
                          title={FRAMES[id].hint}
                        >
                          <FrameGlyph aspect={FRAMES[id].aspect} />
                          <span>{FRAMES[id].label}</span>
                        </button>
                      ))}
                    </div>
                    <p className="note">
                      {videoOut.width} × {videoOut.height}
                      {FRAMES[frame].aspect !== null && ' · drag the box on the video to choose the shot'}
                    </p>
                    {upscale > 2 && (
                      <p
                        className="notice notice-warn"
                        title={`The crop is ${Math.round(videoCrop.width)} × ${Math.round(videoCrop.height)} px in the source and gets enlarged ${upscale.toFixed(1)}× to ${videoOut.width} × ${videoOut.height}.`}
                      >
                        <AlertIcon size={14} />
                        Low-resolution source: enlarged {upscale.toFixed(1)}×, so it will look soft.
                      </p>
                    )}
                  </div>
                )}
              </section>

              <section className="inspector-section">
                <div className="section-head">
                  <h2>Silence</h2>
                  {!thresholdAuto && (
                    <button className="btn btn-quiet btn-xs" onClick={() => setThresholdAuto(true)} title="Set the threshold from this recording's noise floor">
                      Auto threshold
                    </button>
                  )}
                </div>
                <Slider
                  label={thresholdAuto ? 'Threshold (auto)' : 'Threshold'}
                  value={threshold}
                  min={-70}
                  max={-20}
                  step={1}
                  display={`${threshold} dB`}
                  onChange={(v) => {
                    setThresholdAuto(false);
                    setManualThreshold(v);
                  }}
                />
                <Slider label="Shortest gap" value={minGap} min={0.3} max={5} step={0.1} display={`${minGap.toFixed(1)} s`} onChange={setMinGap} />
                <Slider label="Keep around speech" value={padding} min={0} max={0.5} step={0.05} display={`${padding.toFixed(2)} s`} onChange={setPadding} />
                <p className="silence-summary" aria-live="polite">
                  {silences.length === 0
                    ? 'No silences in the clip at these settings.'
                    : `${silences.length} ${silences.length === 1 ? 'silence' : 'silences'} in the clip, ${totalLength(silences).toFixed(1)} s in total.`}
                  {clip.analysedUntil < clip.duration && ' Still analysing, so more may appear.'}
                </p>
                <div className="button-row">
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={cutAllSilences}
                    disabled={silences.every((s) => cutsInClip.some((c) => overlaps(c, s)))}
                  >
                    Cut all silences
                  </button>
                  {cuts.length > 0 && (
                    <button className="btn btn-quiet btn-sm" onClick={() => setCuts([])}>
                      Restore all
                    </button>
                  )}
                </div>
              </section>

              <section className="inspector-section">
                <div className="section-head">
                  <h2>Volume</h2>
                  {(gainDb !== 0 || fadeIn !== 0 || fadeOut !== 0) && (
                    <button
                      className="btn btn-quiet btn-xs"
                      onClick={() => {
                        setGainDb(0);
                        setFadeIn(0);
                        setFadeOut(0);
                      }}
                    >
                      Reset
                    </button>
                  )}
                </div>
                <FadePreview gainDb={gainDb} fadeIn={fadeIn} fadeOut={fadeOut} length={outputLength} />
                <Slider label="Gain" value={gainDb} min={-24} max={12} step={0.5} display={`${gainDb > 0 ? '+' : ''}${gainDb.toFixed(1)} dB`} onChange={setGainDb} />
                <Slider label="Fade in" value={fadeIn} min={0} max={10} step={0.1} display={`${fadeIn.toFixed(1)} s`} onChange={setFadeIn} />
                <Slider label="Fade out" value={fadeOut} min={0} max={10} step={0.1} display={`${fadeOut.toFixed(1)} s`} onChange={setFadeOut} />
              </section>

            </div>

            <div className="inspector-footer">
              <dl className="summary">
                {removed > 0 && (
                  <>
                    <div>
                      <dt>Start to end</dt>
                      <dd>{formatTime(clipLength)}</dd>
                    </div>
                    <div>
                      <dt>
                        {cutsInClip.length} {cutsInClip.length === 1 ? 'cut' : 'cuts'}
                      </dt>
                      <dd>−{removed.toFixed(1)} s</dd>
                    </div>
                  </>
                )}
                <div className={removed > 0 ? 'summary-total' : undefined}>
                  <dt>Length</dt>
                  <dd>{formatTime(outputLength)}</dd>
                </div>
                <div>
                  <dt>Estimated size</dt>
                  <dd>{formatBytes(estimate)}</dd>
                </div>
              </dl>
              <button className="btn btn-primary btn-block export-btn" onClick={exportClip} disabled={busy !== null}>
                {busy && <span className="progress" style={{ width: `${(busy.ratio ?? 0) * 100}%` }} />}
                <span className="export-label">
                  {busy ? (
                    `${busy.stage}…`
                  ) : (
                    <>
                      <DownloadIcon size={16} />
                      {format === 'mp4' ? 'Export video' : 'Export clip'}
                    </>
                  )}
                </span>
              </button>
              {busy && exportRun.current && (
                <button className="btn btn-quiet btn-sm btn-block cancel-btn" onClick={() => exportRun.current?.cancel()}>
                  Cancel export
                </button>
              )}
              {format === 'mp3' && (
                <p className="note">The first MP3 export downloads a 30 MB encoder. This only happens once per visit.</p>
              )}
            </div>
          </aside>
        </div>
      )}

      {clip && (
        <footer className="statusbar">
          <span>{formatTime(clip.duration)}</span>
          <span>{(clip.sampleRate / 1000).toFixed(1)} kHz</span>
          <span>{channelName(clip.numberOfChannels)}</span>
          {clip.details.map((d) => (
            <span key={d}>{d}</span>
          ))}
          <span className="statusbar-optional">{clip.memoryNote}</span>
          <span className="statusbar-optional">
            {clip.analysedUntil < clip.duration
              ? `Analysing ${Math.floor((clip.analysedUntil / clip.duration) * 100)}%`
              : clip.sourceNote}
          </span>
          <span
            className="statusbar-end"
            title={
              crossOriginIsolated
                ? 'The page is cross-origin isolated, so the MP3 encoder can use several CPU threads.'
                : 'The page is not cross-origin isolated, so the MP3 encoder runs on one thread.'
            }
          >
            <span className={`status-dot ${crossOriginIsolated ? 'ok' : 'warn'}`} />
            MP3 encoder: {crossOriginIsolated ? 'multithreaded' : 'single thread'}
          </span>
        </footer>
      )}

      <ShortcutsDialog ref={shortcutsDialog} />

      {dragOver && clip && (
        <div className="drop-overlay">
          <UploadIcon size={28} />
          <span>Drop to open this file instead</span>
        </div>
      )}

      {toast && (
        <div className={`toast toast-${toast.kind}`} role="status">
          <span className="toast-icon">{toast.kind === 'success' ? <CheckIcon size={16} /> : <AlertIcon size={16} />}</span>
          <div className="toast-body">
            <strong>{toast.title}</strong>
            {toast.detail && <span>{toast.detail}</span>}
          </div>
          <button className="toast-close" onClick={() => setToast(null)} aria-label="Dismiss">
            <CloseIcon size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function OpenScreen(props: { loading: string | null; dragOver: boolean; onBrowse: () => void; onSample: () => void }) {
  return (
    <main className="open">
      <div className="open-grid">
        <div className="open-copy">
          <h1>Cut long recordings into short clips.</h1>
          <p className="open-lede">
            Open an interview, podcast or screen recording. Mark the part you want, drop the silences, and export a
            vertical video or an audio clip. Everything happens in this tab; the file is never uploaded.
          </p>
          <div className="open-actions">
            <button className="btn btn-primary btn-lg" onClick={props.onBrowse} disabled={!!props.loading}>
              Choose a file
            </button>
            <button className="btn btn-outline btn-lg" onClick={props.onSample} disabled={!!props.loading}>
              Try the sample
            </button>
          </div>
          <dl className="open-facts">
            <div>
              <dt>Opens</dt>
              <dd>MP4, MOV, WebM, MKV, WAV, MP3, M4A, OGG, FLAC</dd>
            </div>
            <div>
              <dt>Exports</dt>
              <dd>9:16 or 1:1 MP4 (H.264 + AAC), WAV, MP3</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>Hours-long files are fine. They're read from disk in pieces, never loaded whole.</dd>
            </div>
          </dl>
        </div>

        <div
          className={`dropzone ${props.dragOver ? 'is-over' : ''}`}
          onClick={props.loading ? undefined : props.onBrowse}
          role="button"
          tabIndex={0}
          aria-label="Choose a file, or drop one here"
          aria-busy={!!props.loading}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && !props.loading) {
              e.preventDefault();
              props.onBrowse();
            }
          }}
        >
          <EditorSketch />
          <div className="dropzone-text">
            {props.loading ? (
              <span className="dropzone-loading" role="status">
                <span className="spinner" />
                {props.loading}…
              </span>
            ) : (
              <>
                <strong>{props.dragOver ? 'Release to open' : 'Drop a file here'}</strong>
                <span>or click to choose one</span>
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * A miniature of the editor itself (waveform, clip brackets, a cut silence and
 * the playhead) so the open screen shows what the tool does, not a generic upload icon.
 */
function EditorSketch() {
  const W = 480;
  const H = 150;
  const mid = 70;
  // Deterministic "speech": phrases of syllables with pauses between them.
  const bars: number[] = [];
  for (let i = 0; i < W / 4; i++) {
    const phrase = Math.sin(i * 0.16) * Math.sin(i * 0.043 + 1);
    const pause = (i > 52 && i < 62) || (i > 96 && i < 101);
    const v = pause ? 0.03 : Math.max(0.05, Math.abs(phrase) * (0.55 + 0.45 * Math.abs(Math.sin(i * 1.3))));
    bars.push(v);
  }
  const inX = 96;
  const outX = 372;
  const cut = { x0: 212, x1: 244 };
  const playX = 160;
  return (
    <svg className="sketch" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <defs>
        <pattern id="sketch-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" className="sketch-hatch-line" />
        </pattern>
      </defs>
      <rect x={inX} y="8" width={outX - inX} height={H - 34} className="sketch-selection" />
      {bars.map((v, i) => {
        const x = i * 4;
        const inside = x >= inX && x <= outX;
        const h = Math.max(1.5, v * 56);
        return <rect key={i} x={x + 0.5} y={mid - h} width="2.2" height={h * 2} className={inside ? 'sketch-wave' : 'sketch-wave-idle'} />;
      })}
      <rect x={cut.x0} y="8" width={cut.x1 - cut.x0} height={H - 34} fill="url(#sketch-hatch)" className="sketch-cut" />
      <rect x={cut.x0} y={H - 20} width={cut.x1 - cut.x0} height="8" className="sketch-cut-block" />
      <rect x="250" y={H - 20} width="18" height="8" className="sketch-silence-block" />
      <path d={`M${inX} 8 h8 M${inX} 8 v${H - 34} h8`} className="sketch-bracket" />
      <path d={`M${outX} 8 h-8 M${outX} 8 v${H - 34} h-8`} className="sketch-bracket" />
      <line x1={playX} y1="2" x2={playX} y2={H - 26} className="sketch-playhead" />
      <rect x={playX - 4} y="0" width="8" height="5" className="sketch-playhead-head" />
    </svg>
  );
}

function ShortcutsDialog({ ref }: { ref: Ref<HTMLDialogElement> }) {
  const groups: [string, [string[], string][]][] = [
    [
      'Playback',
      [
        [['Space'], 'Play or pause'],
        [['Home'], 'Go to clip start'],
        [['End'], 'Go to clip end'],
        [['←', '→'], 'Move 1 second'],
        [['Shift', '←', '→'], 'Move 5 seconds'],
        [['L'], 'Loop the clip'],
      ],
    ],
    [
      'Editing',
      [
        [['I'], 'Set clip start at playhead'],
        [['O'], 'Set clip end at playhead'],
      ],
    ],
    [
      'View',
      [
        [['+', '−'], 'Zoom in or out'],
        [['0'], 'Show the whole file'],
        [['Ctrl', 'Scroll'], 'Zoom at the pointer'],
        [['Scroll'], 'Move along the timeline'],
      ],
    ],
  ];
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="shortcuts-title"
      onClick={(e) => {
        // Close when clicking the backdrop.
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
    >
      <div className="dialog-head">
        <h2 id="shortcuts-title">Keyboard shortcuts</h2>
        <form method="dialog">
          <button className="icon-btn" aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </form>
      </div>
      <div className="dialog-body">
        {groups.map(([title, rows]) => (
          <section key={title}>
            <h3>{title}</h3>
            <dl className="shortcut-list">
              {rows.map(([keys, desc]) => (
                <div key={desc}>
                  <dt>
                    {keys.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </dt>
                  <dd>{desc}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </dialog>
  );
}

function IconButton(props: { label: string; onClick: () => void; active?: boolean; children: ReactNode }) {
  return (
    <button
      className={`icon-btn ${props.active ? 'is-active' : ''}`}
      onClick={props.onClick}
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
    >
      {props.children}
    </button>
  );
}

/** A time input that shows m:ss.cc and accepts typed times; commits on Enter or blur, reverts on Escape. */
function TimeField({ label, value, onCommit }: { label: string; value: number; onCommit: (t: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  const commit = () => {
    if (draft === null) return;
    const t = parseTime(draft);
    if (t === null) {
      setInvalid(true);
      setTimeout(() => setInvalid(false), 600);
    } else {
      onCommit(t);
    }
    setDraft(null);
  };

  return (
    <label className={`field ${invalid ? 'is-invalid' : ''}`}>
      <span className="field-label">{label}</span>
      <input
        className="field-value"
        value={draft ?? formatTime(value)}
        spellCheck={false}
        inputMode="decimal"
        aria-label={`Clip ${label.toLowerCase()} time`}
        onFocus={(e) => {
          setDraft(formatTime(value));
          const input = e.currentTarget;
          requestAnimationFrame(() => input.select());
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setDraft(null);
            const input = e.currentTarget;
            requestAnimationFrame(() => input.blur());
          }
        }}
      />
    </label>
  );
}

const FORMAT_INFO: Record<Format, { label: string; text: string }> = {
  mp4: { label: 'Video', text: 'MP4 with H.264 video and AAC audio, cropped to the frame you choose.' },
  wav: { label: 'WAV', text: 'Audio only, uncompressed. Best quality, larger file.' },
  mp3: { label: 'MP3', text: `Audio only, ${MP3_KBPS} kbps. Small and plays anywhere.` },
};

/** Updates its own text every frame without re-rendering the rest of the app. */
function Clock({ player, duration }: { player: Player; duration: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (ref.current) ref.current.textContent = formatTime(player.position);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [player]);
  return (
    <div className="clock">
      <span ref={ref} className="clock-now" />
      <span className="clock-total">of {formatTime(duration)}</span>
    </div>
  );
}

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  const pct = ((props.value - props.min) / (props.max - props.min)) * 100;
  return (
    <label className="slider">
      <span className="slider-head">
        <span>{props.label}</span>
        <output>{props.display}</output>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        style={{ '--pct': `${pct}%` } as CSSProperties}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

/** Gain envelope of the exported clip; the dashed line is 0 dB. */
function FadePreview({ gainDb, fadeIn, fadeOut, length }: { gainDb: number; fadeIn: number; fadeOut: number; length: number }) {
  const W = 240;
  const H = 48;
  const yFor = (gain: number) => 6 + (1 - Math.min(1, gain / dbToGain(12))) * (H - 12);
  const top = yFor(dbToGain(gainDb));
  const unity = yFor(1);
  const fi = Math.min(fadeIn, length / 2) / length;
  const fo = Math.min(fadeOut, length / 2) / length;
  const pts = `0,${fi > 0 ? H : top} ${fi * W},${top} ${(1 - fo) * W},${top} ${W},${fo > 0 ? H : top}`;
  return (
    <svg className="fade-preview" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Volume over the length of the clip">
      <line x1="0" x2={W} y1={unity} y2={unity} className="unity" />
      <polygon points={`${pts} ${W},${H} 0,${H}`} className="area" />
      <polyline points={pts} className="line" />
    </svg>
  );
}

const CODEC_NAMES: Record<string, string> = {
  aac: 'AAC',
  mp3: 'MP3',
  opus: 'Opus',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  avc: 'H.264',
  hevc: 'H.265',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
};
const CONTAINER_NAMES: Record<string, string> = { WAVE: 'WAV', 'QuickTime File Format': 'MOV' };

function describeMedia(info: MediaInfo): string[] {
  const container = CONTAINER_NAMES[info.container] ?? info.container;
  const codec = info.audioCodec.startsWith('pcm') ? 'PCM' : (CODEC_NAMES[info.audioCodec] ?? info.audioCodec);
  const details = [container.toLowerCase() === codec.toLowerCase() ? container : `${container} · ${codec}`];
  if (info.video) {
    const vcodec = CODEC_NAMES[info.video.codec] ?? info.video.codec;
    details.push(`Video ${info.video.width}×${info.video.height} ${vcodec}`);
  }
  return details;
}

/** The stage for audio-only files: the live spectrum takes the place of a picture. */
function AudioStage(props: { analyser: AnalyserNode; theme: string; name: string; details: string[] }) {
  return (
    <div className="audio-stage">
      <div className="audio-stage-viz">
        <Visualizer analyser={props.analyser} theme={props.theme} />
      </div>
      <div className="audio-stage-caption">
        <span className="audio-stage-name">{props.name}</span>
        <span className="audio-stage-details">{props.details.join(' · ')}</span>
      </div>
    </div>
  );
}

/** A small outline of the frame shape for the frame picker. */
function FrameGlyph({ aspect }: { aspect: number | null }) {
  const a = aspect ?? 16 / 9;
  const w = a >= 1 ? 18 : 18 * a;
  const h = a >= 1 ? 18 / a : 18;
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <rect x={10 - w / 2} y={10 - h / 2} width={w} height={h} rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function channelName(n: number) {
  return n === 1 ? 'Mono' : n === 2 ? 'Stereo' : `${n} channels`;
}

function dbToGain(db: number) {
  return Math.pow(10, db / 20);
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
