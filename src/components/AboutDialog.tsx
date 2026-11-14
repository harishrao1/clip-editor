import type { Ref } from 'react';
import { CloseIcon, LogoMark } from './Icons';

export const REPO_URL = 'https://github.com/harishrao1/clip-editor';
export const APP_VERSION = `${__APP_VERSION__} (${__APP_COMMIT__})`;

/** A readable browser and OS, e.g. "Chrome 131 on Windows". */
function describeBrowser(): string {
  const ua = navigator.userAgent;
  const browser =
    /Edg\/(\d+)/.exec(ua)?.[0].replace('Edg/', 'Edge ') ??
    /OPR\/(\d+)/.exec(ua)?.[0].replace('OPR/', 'Opera ') ??
    /Firefox\/(\d+)/.exec(ua)?.[0].replace('/', ' ') ??
    /Chrome\/(\d+)/.exec(ua)?.[0].replace('/', ' ') ??
    (/Version\/(\d+)[\d.]* .*Safari/.exec(ua) ? `Safari ${/Version\/(\d+)/.exec(ua)![1]}` : 'Unknown browser');
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'unknown OS';
  return `${browser} on ${os}`;
}

/**
 * A link to a new bug report with the environment already filled in. It holds
 * only browser capabilities and the app version: never file names or media details.
 */
export function bugReportUrl(): string {
  const environment = [
    `${describeBrowser()} · Clip Editor ${APP_VERSION}`,
    `WebCodecs: ${'AudioDecoder' in window && 'VideoDecoder' in window ? 'yes' : 'no'}`,
    `Cross-origin isolated: ${self.crossOriginIsolated ? 'yes' : 'no'}`,
    `Screen: ${window.innerWidth}×${window.innerHeight}`,
  ].join('\n');
  const params = new URLSearchParams({ template: 'bug_report.yml', environment });
  return `${REPO_URL}/issues/new?${params}`;
}

const CREDITS: [name: string, what: string, licence: string, url: string][] = [
  ['Mediabunny', 'Reading and writing media files, WebCodecs decoding and encoding', 'MPL-2.0', 'https://mediabunny.dev'],
  ['FFmpeg.wasm', 'MP3 encoding with FFmpeg and LAME, downloaded only when you export an MP3', 'MIT; FFmpeg core GPL-2.0+', 'https://github.com/ffmpegwasm/ffmpeg.wasm'],
  ['Geist', 'Sans and mono typefaces by Vercel', 'OFL-1.1', 'https://vercel.com/font'],
  ['React', 'Interface', 'MIT', 'https://react.dev'],
];

export function AboutDialog({ ref }: { ref: Ref<HTMLDialogElement> }) {
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="about-title"
      onClick={(e) => {
        // Close when clicking the backdrop.
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
    >
      <div className="dialog-head">
        <h2 id="about-title">About Clip Editor</h2>
        <form method="dialog">
          <button className="icon-btn" aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </form>
      </div>
      <div className="dialog-body">
        <div className="about-intro">
          <LogoMark size={40} />
          <div>
            <strong>Clip Editor</strong>
            <span className="mono">Version {APP_VERSION}</span>
          </div>
        </div>
        <p className="about-text">
          Made by Harish Rao. A browser-only editor for cutting long recordings into short clips. Your files are
          decoded, edited and encoded in this tab and are never uploaded.
        </p>
        <div className="about-actions">
          <a
            className="btn btn-outline btn-sm"
            href={bugReportUrl()}
            onClick={(e) => (e.currentTarget.href = bugReportUrl())}
            target="_blank"
            rel="noreferrer"
          >
            Report a problem
          </a>
          <a
            className="btn btn-outline btn-sm"
            href={`${REPO_URL}/issues/new?template=feature_request.yml`}
            target="_blank"
            rel="noreferrer"
          >
            Suggest a feature
          </a>
          <a className="btn btn-quiet btn-sm" href={REPO_URL} target="_blank" rel="noreferrer">
            Source on GitHub
          </a>
        </div>
        <section>
          <h3>Built with</h3>
          <ul className="credits">
            {CREDITS.map(([name, what, licence, url]) => (
              <li key={name}>
                <a href={url} target="_blank" rel="noreferrer">
                  {name}
                </a>
                <span>{what}</span>
                <span className="credit-licence mono">{licence}</span>
              </li>
            ))}
          </ul>
          <p className="note">Clip Editor itself is released under the MIT licence.</p>
        </section>
      </div>
    </dialog>
  );
}
