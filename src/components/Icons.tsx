import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 18, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const PlayIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 5v14l11-7z" fill="currentColor" stroke="none" />
  </Icon>
);
export const PauseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none" />
  </Icon>
);
export const ToStartIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M18 6v12l-9-6z" fill="currentColor" stroke="none" />
    <path d="M6.5 6v12" />
  </Icon>
);
export const ToEndIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6v12l9-6z" fill="currentColor" stroke="none" />
    <path d="M17.5 6v12" />
  </Icon>
);
export const BackIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 7l-5 5 5 5M18 7l-5 5 5 5" />
  </Icon>
);
export const ForwardIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 7l5 5-5 5M6 7l5 5-5 5" />
  </Icon>
);
export const LoopIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 12V9a3 3 0 0 1 3-3h11M15 3l3 3-3 3M20 12v3a3 3 0 0 1-3 3H6M9 21l-3-3 3-3" />
  </Icon>
);
export const MinusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 12h12" />
  </Icon>
);
export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 12h12M12 6v12" />
  </Icon>
);
export const UploadIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 16V4M7 9l5-5 5 5M4 15v5h16v-5" />
  </Icon>
);
export const DownloadIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4v11M7 10l5 5 5-5M4 20h16" />
  </Icon>
);
export const FolderIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 6.5V18a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8.5a1 1 0 0 0-1-1h-8l-2-2.5H4a1 1 0 0 0-1 1z" strokeLinejoin="round" />
  </Icon>
);
export const KeyboardIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="6" width="18" height="12" rx="1.5" />
    <path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" strokeWidth={2} />
  </Icon>
);
export const SunIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Icon>
);
export const MoonIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
  </Icon>
);
export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);
export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);
export const AlertIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 8v5M12 16.5v.5" strokeWidth={2} />
    <circle cx="12" cy="12" r="9" />
  </Icon>
);

/** The app mark: in/out brackets with a playhead between them, on an accent tile. */
export const LogoMark = ({ size = 26 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="8" fill="var(--accent)" />
    <path d="M11 8H8v16h3M21 8h3v16h-3" fill="none" stroke="#fff" strokeWidth="2.5" />
    <rect x="14.75" y="7" width="2.5" height="18" rx="1" fill="#fff" />
  </svg>
);
