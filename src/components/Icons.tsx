// 自作の単純なSVGピクト（22px／stroke 1.8px）。意味のない装飾アイコンは増やさない。
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className: 'icon',
  'aria-hidden': true,
  focusable: false,
  ...p,
});

/** 返却矢印＋確認枠（仮マーク。正式ロゴではない） */
export const MarkIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M10 7H5v12h12v-4" />
    <path d="M17 15.5c2.6-1.9 3.1-5.1 1.4-7-1.1-1.2-2.8-1.7-4.8-1.6" />
    <path d="M15.6 4.3l-2.6 2.6 2.6 2.6" />
  </svg>
);
export const BackIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
);
export const ChevronIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 5l7 7-7 7" />
  </svg>
);
export const ScanIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />
    <path d="M8 12h8" />
  </svg>
);
export const PhotoIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="6" width="18" height="14" rx="2" />
    <circle cx="12" cy="13" r="3.5" />
    <path d="M8 6l1.5-2h5L16 6" />
  </svg>
);
export const CheckIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);
export const AlertIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3l9.5 17h-19z" />
    <path d="M12 10v4.5M12 17.5v.5" />
  </svg>
);
export const ErrorIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9 9l6 6M15 9l-6 6" />
  </svg>
);
export const SendBackIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 14l-5-5 5-5" />
    <path d="M4 9h10a6 6 0 010 12h-3" />
  </svg>
);
export const ExportIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3v12M7 10l5 5 5-5" />
    <path d="M4 17v3h16v-3" />
  </svg>
);
export const DocIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4M9 12h6M9 16h6" />
  </svg>
);
export const ClockIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
export const MenuIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);
