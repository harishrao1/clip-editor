import { useState } from 'react';

export type ThemeName = 'light' | 'dark';

/** The design is light-first; dark is an explicit choice that's remembered. */
const DEFAULT_THEME: ThemeName = 'light';

function savedTheme(): ThemeName | null {
  try {
    const v = localStorage.getItem('theme');
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

export function useTheme(): [ThemeName, () => void] {
  const [theme, setTheme] = useState<ThemeName>(() => savedTheme() ?? DEFAULT_THEME);

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    // Set the attribute before React re-renders: child components read CSS
    // variables for canvas drawing in their own effects, which run first.
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try {
      localStorage.setItem('theme', next);
    } catch {
      // Storage can be unavailable (private mode); the toggle still works for this visit.
    }
  };

  return [theme, toggle];
}

/** Reads a set of CSS custom properties from :root, for canvas drawing. */
export function readColors<K extends string>(names: Record<K, string>): Record<K, string> {
  const style = getComputedStyle(document.documentElement);
  const out = {} as Record<K, string>;
  for (const key in names) out[key] = style.getPropertyValue(names[key]).trim();
  return out;
}
