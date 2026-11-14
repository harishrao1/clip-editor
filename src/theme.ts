import { useState } from 'react';
import { DEFAULT_THEME, THEMES, type ThemeId } from './themeList';

export { THEMES, type ThemeId };

/** Earlier versions stored just 'light' or 'dark'; map those onto today's themes. */
const LEGACY: Record<string, ThemeId> = { light: 'sand', dark: 'graphite' };

function isTheme(v: string | null): v is ThemeId {
  return THEMES.some((t) => t.id === v);
}

function savedTheme(): ThemeId | null {
  try {
    const v = localStorage.getItem('theme');
    if (v && LEGACY[v]) return LEGACY[v];
    return isTheme(v) ? v : null;
  } catch {
    return null;
  }
}

/** Applies a theme to the document: the data attribute drives CSS, the meta tag tints mobile browser chrome. */
function applyTheme(id: ThemeId) {
  document.documentElement.dataset.theme = id;
  const bg = THEMES.find((t) => t.id === id)?.bg;
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
}

export function useTheme(): [ThemeId, (id: ThemeId) => void] {
  const [theme, setThemeState] = useState<ThemeId>(() => {
    const initial = savedTheme() ?? DEFAULT_THEME;
    applyTheme(initial);
    return initial;
  });

  const setTheme = (id: ThemeId) => {
    // Set the attribute before React re-renders: child components read CSS
    // variables for canvas drawing in their own effects, which run first.
    applyTheme(id);
    setThemeState(id);
    try {
      localStorage.setItem('theme', id);
    } catch {
      // Storage can be unavailable (private mode); the choice still applies for this visit.
    }
  };

  return [theme, setTheme];
}

/** Reads a set of CSS custom properties from :root, for canvas drawing. */
export function readColors<K extends string>(names: Record<K, string>): Record<K, string> {
  const style = getComputedStyle(document.documentElement);
  const out = {} as Record<K, string>;
  for (const key in names) out[key] = style.getPropertyValue(names[key]).trim();
  return out;
}
