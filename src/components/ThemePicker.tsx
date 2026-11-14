import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { THEMES, type ThemeId } from '../theme';
import { CheckIcon } from './Icons';

type Theme = (typeof THEMES)[number];

/** A small picture of the theme: window frame, a panel and the accent. */
function ThemeChip({ t }: { t: Theme }) {
  return (
    <span className="theme-chip" style={{ background: t.bg, borderColor: t.mode === 'dark' ? t.panel : 'rgba(0,0,0,0.08)' }} aria-hidden="true">
      <span style={{ background: t.panel }}>
        <i style={{ background: t.text, opacity: 0.35 }} />
        <i style={{ background: t.accent }} />
      </span>
    </span>
  );
}

/**
 * Theme menu in the top bar. Choosing a theme applies it at once and keeps the
 * menu open, so people can compare themes before closing it.
 */
export function ThemePicker({ theme, onChange }: { theme: ThemeId; onChange: (id: ThemeId) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const current = THEMES.find((t) => t.id === theme) ?? THEMES[0];

  useEffect(() => {
    if (!open) return;
    // Focus the selected option when the menu opens.
    root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const onMenuKey = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('.theme-option') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  const group = (mode: 'light' | 'dark', label: string) => (
    <div className="theme-group" role="group" aria-label={label}>
      <div className="theme-group-label">{label}</div>
      {THEMES.filter((t) => t.mode === mode).map((t) => (
        <button
          key={t.id}
          type="button"
          role="menuitemradio"
          aria-checked={t.id === theme}
          className="theme-option"
          onClick={() => onChange(t.id)}
        >
          <ThemeChip t={t} />
          <span className="theme-name">{t.name}</span>
          {t.id === theme && <CheckIcon size={14} />}
        </button>
      ))}
    </div>
  );

  return (
    <div className="theme-picker" ref={root}>
      <button
        ref={button}
        type="button"
        className="theme-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Change theme"
        aria-label={`Theme: ${current.name}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="theme-dot" style={{ background: current.accent }} aria-hidden="true" />
        <span className="theme-trigger-label">{current.name}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      {open && (
        <div className="theme-menu" id={menuId} role="menu" aria-label="Theme" onKeyDown={onMenuKey}>
          {group('light', 'Light')}
          {group('dark', 'Dark')}
        </div>
      )}
    </div>
  );
}
