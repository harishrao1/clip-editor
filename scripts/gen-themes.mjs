// Generates src/themes.css and src/themeList.ts from the palettes below.
// Each theme defines ~18 base colours; every other token (timeline canvas,
// spectrum, shadows, tints) is derived, so themes stay consistent.
//
//   node scripts/gen-themes.mjs
//
import { writeFileSync } from 'node:fs';

/** The first theme is the default and is also emitted on :root. */
const THEMES = [
  {
    id: 'sand', name: 'Sand', mode: 'light',
    bg: '#f3ece2', panel: '#fbf7f1', sunken: '#f5eee4', raised: '#fffdf9', stage: '#ebe2d4',
    line: '#e5dccf', lineStrong: '#d3c6b4', text: '#2a201a', text2: '#5a4b40', muted: '#8d7e70',
    accent: '#b9502a', accentHover: '#a3441f', accentText: '#ffffff', accentInk: '#a3441f',
    danger: '#9f1239', ok: '#2f7d4f', warn: '#9a6206', wave: '#c2552d',
  },
  {
    id: 'lavender', name: 'Lavender', mode: 'light',
    bg: '#f4f2fa', panel: '#ffffff', sunken: '#f8f6fc', raised: '#ffffff', stage: '#ebe7f5',
    line: '#e2ddf0', lineStrong: '#cdc6e2', text: '#1e1a2e', text2: '#4c4566', muted: '#827b9a',
    accent: '#7c3aed', accentHover: '#6d28d9', accentText: '#ffffff', accentInk: '#6d28d9',
    danger: '#e11d48', ok: '#15803d', warn: '#a16207', wave: '#8b5cf6',
  },
  {
    id: 'sky', name: 'Sky', mode: 'light',
    bg: '#eef4fb', panel: '#ffffff', sunken: '#f5f8fc', raised: '#ffffff', stage: '#e3ecf6',
    line: '#dde6f1', lineStrong: '#c7d4e5', text: '#0f1b2d', text2: '#3f4f66', muted: '#7a899f',
    accent: '#0274b3', accentHover: '#03649a', accentText: '#ffffff', accentInk: '#0369a1',
    danger: '#dc2626', ok: '#15803d', warn: '#a16207', wave: '#0ea5e9',
  },
  {
    id: 'sand-night', name: 'Sand night', mode: 'dark',
    bg: '#15110e', panel: '#1e1915', sunken: '#191511', raised: '#29221d', stage: '#100d0b',
    line: '#2e2721', lineStrong: '#3e352d', text: '#f1e9df', text2: '#c4b6a6', muted: '#8e8072',
    accent: '#e07a4f', accentHover: '#ea8c63', accentText: '#1d0d05', accentInk: '#ec9068',
    danger: '#f0607a', ok: '#5cc98a', warn: '#e3b24f', wave: '#e07a4f',
  },
  {
    id: 'graphite', name: 'Graphite', mode: 'dark',
    bg: '#0f0f11', panel: '#18181b', sunken: '#131316', raised: '#222226', stage: '#0b0b0d',
    line: '#27272c', lineStrong: '#36363c', text: '#ecebe8', text2: '#b5b3ad', muted: '#817f79',
    accent: '#f5a524', accentHover: '#ffb84d', accentText: '#1a1305', accentInk: '#f7b247',
    danger: '#ef5b4c', ok: '#4fcf8b', warn: '#e8c547', wave: '#f5a524',
  },
  {
    id: 'ocean', name: 'Ocean', mode: 'dark',
    bg: '#0a1220', panel: '#101b2e', sunken: '#0d1626', raised: '#172440', stage: '#070d18',
    line: '#1d2b44', lineStrong: '#2a3b5a', text: '#e3ecf7', text2: '#a9b8cc', muted: '#7487a0',
    accent: '#22d3ee', accentHover: '#4fe0f5', accentText: '#04222a', accentInk: '#5ee3f5',
    danger: '#f87171', ok: '#4ade80', warn: '#fbbf24', wave: '#22d3ee',
  },
  {
    id: 'midnight', name: 'Midnight', mode: 'dark',
    bg: '#0d0b14', panel: '#16131f', sunken: '#110f19', raised: '#201c2c', stage: '#08070d',
    line: '#262135', lineStrong: '#352e48', text: '#ecebf5', text2: '#b6b1c9', muted: '#7f7896',
    accent: '#8b5cf6', accentHover: '#9d74f8', accentText: '#ffffff', accentInk: '#b49cfb',
    danger: '#f43f5e', ok: '#4ade80', warn: '#fbbf24', wave: '#a78bfa',
  },
];

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
/** `a` weighted by t, `b` by 1 - t. */
const mix = (a, b, t) => hex(rgb(a).map((v, i) => v * t + rgb(b)[i] * (1 - t)));
const alpha = (c, a) => `rgba(${rgb(c).join(', ')}, ${a})`;

function tokens(t) {
  const dark = t.mode === 'dark';
  return {
    bg: t.bg, panel: t.panel, 'panel-sunken': t.sunken, 'panel-raised': t.raised, stage: t.stage,
    line: t.line, 'line-strong': t.lineStrong, text: t.text, 'text-2': t.text2, muted: t.muted,
    accent: t.accent, 'accent-hover': t.accentHover, 'accent-text': t.accentText, 'accent-ink': t.accentInk,
    'accent-soft': alpha(t.accent, dark ? 0.15 : 0.11),
    danger: t.danger, ok: t.ok, warn: t.warn, focus: dark ? t.accent : t.accentInk,
    overlay: dark ? 'rgba(0, 0, 0, 0.62)' : alpha(t.text, 0.38),
    'shadow-panel': dark
      ? '0 0 0 1px rgba(0, 0, 0, 0.3), 0 10px 30px rgba(0, 0, 0, 0.28)'
      : `0 1px 2px ${alpha(t.text, 0.05)}, 0 6px 20px ${alpha(t.text, 0.06)}`,
    'shadow-control': dark ? '0 1px 2px rgba(0, 0, 0, 0.45)' : `0 1px 2px ${alpha(t.text, 0.08)}`,
    'shadow-pop': dark
      ? '0 24px 60px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.06)'
      : `0 20px 48px ${alpha(t.text, 0.18)}, 0 2px 6px ${alpha(t.text, 0.06)}`,
    highlight: dark ? 'inset 0 1px 0 rgba(255, 255, 255, 0.045)' : 'inset 0 1px 0 rgba(255, 255, 255, 0.9)',
    glow: `0 0 0 1px ${alpha(t.accent, 0.35)}, 0 8px 28px ${alpha(t.accent, 0.18)}`,

    'tl-bg': dark ? mix(t.panel, t.bg, 0.5) : t.raised,
    'tl-ruler': dark ? t.panel : t.sunken,
    'tl-ruler-line': t.line,
    'tl-tick': mix(t.text, t.panel, dark ? 0.28 : 0.32),
    'tl-tick-minor': dark ? mix(t.line, t.panel, 0.6) : t.line,
    'tl-label': t.muted,
    'tl-grid': alpha(t.text, dark ? 0.025 : 0.035),
    'tl-center': alpha(t.accent, 0.2),
    'tl-wave-idle': mix(t.text, t.panel, dark ? 0.17 : 0.16),
    'tl-wave': t.wave,
    'tl-selection': alpha(t.accent, dark ? 0.05 : 0.055),
    'tl-dim': alpha(t.bg, 0.6),
    'tl-handle': t.text,
    'tl-handle-grip': alpha(t.panel, 0.75),
    'tl-playhead': t.text,
    'tl-hover': alpha(t.text, 0.32),
    'tl-bubble': t.text,
    'tl-bubble-text': t.panel,
    'tl-mini-bg': t.sunken,
    'tl-mini-wave': mix(t.text, t.panel, dark ? 0.12 : 0.13),
    'tl-mini-wave-sel': mix(t.wave, t.panel, 0.6),
    'tl-viewport': alpha(t.accent, 0.08),
    'tl-viewport-edge': alpha(t.accentInk, 0.7),
    'tl-silence': alpha(t.muted, dark ? 0.09 : 0.12),
    'tl-silence-block': mix(t.muted, t.panel, 0.85),
    'tl-cut': alpha(t.danger, dark ? 0.1 : 0.08),
    'tl-cut-line': alpha(t.danger, 0.47),
    'tl-cut-block': t.danger,
    'tl-lane-bg': dark ? mix(t.panel, t.bg, 0.5) : t.sunken,

    'viz-bar': mix(t.text, t.panel, dark ? 0.16 : 0.14),
    'viz-cap': t.wave,
    'viz-base': t.line,
  };
}

function block(selector, t) {
  const body = Object.entries(tokens(t)).map(([k, v]) => `  --${k}: ${v};`).join('\n');
  return `${selector} {\n${body}\n\n  color-scheme: ${t.mode};\n}\n`;
}

let css = `/* Generated by scripts/gen-themes.mjs. Edit the palettes there, then re-run it. */\n\n`;
css += block(`:root,\n:root[data-theme='${THEMES[0].id}']`, THEMES[0]);
for (const t of THEMES.slice(1)) css += '\n' + block(`:root[data-theme='${t.id}']`, t);
writeFileSync(new URL('../src/themes.css', import.meta.url), css);

const list = THEMES.map(({ id, name, mode, bg, panel, accent, text }) => ({ id, name, mode, bg, panel, accent, text }));
const ts = `// Generated by scripts/gen-themes.mjs. Edit the palettes there, then re-run it.

export const THEMES = ${JSON.stringify(list, null, 2)} as const;

export type ThemeId = (typeof THEMES)[number]['id'];
export const DEFAULT_THEME: ThemeId = '${THEMES[0].id}';
`;
writeFileSync(new URL('../src/themeList.ts', import.meta.url), ts);
console.log(`Wrote ${THEMES.length} themes.`);
