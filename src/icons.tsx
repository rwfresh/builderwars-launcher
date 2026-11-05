// Inline stroke icons for the shell (no icon font or package: the production CSP only allows our own assets).
// 24px grid, 1.75 stroke, round caps. Decorative: the button around each icon carries the aria-label.
import type { ReactNode } from "react";

function Icon({ size = 18, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconBack = () => (
  <Icon>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Icon>
);

export const IconReload = () => (
  <Icon>
    <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
  </Icon>
);

export const IconHome = () => (
  <Icon>
    <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1v-9z" />
  </Icon>
);

export const IconCollapseLeft = () => (
  <Icon>
    <path d="M15 6l-6 6 6 6" />
  </Icon>
);

export const IconCollapseRight = () => (
  <Icon>
    <path d="M9 6l6 6-6 6" />
  </Icon>
);

export const IconSettings = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Icon>
);

export const IconCycle = () => (
  <Icon>
    <path d="M17 2l3 3-3 3M20 5H9a4 4 0 0 0-4 4v2M7 22l-3-3 3-3M4 19h11a4 4 0 0 0 4-4v-2" />
  </Icon>
);

export const IconFolder = () => (
  <Icon size={16}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
  </Icon>
);

export const IconSend = () => (
  <Icon size={18}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Icon>
);

export const IconTerminal = () => (
  <Icon size={20}>
    <path d="M5 7l5 5-5 5M12 17h7" />
  </Icon>
);
