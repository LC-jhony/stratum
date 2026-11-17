/**
 * Interface glyphs ported from the Valet dashboard (same author). They are the hand-tuned
 * 24×24 set used by the rail and the frequent actions; `iconMap.ts` decides which codicon ids
 * resolve here instead of to Lucide. Monochrome: paths inherit `currentColor`.
 */
import type { ReactNode } from 'react'

export type GlyphName =
  | 'sites' | 'install' | 'php' | 'ports' | 'services'
  | 'settings' | 'sun' | 'moon' | 'panel' | 'search' | 'refresh'
  | 'chevron' | 'check' | 'alert' | 'info' | 'lock' | 'unlock'
  | 'play' | 'stop' | 'restart' | 'terminal' | 'close' | 'copy'
  | 'globe' | 'spinner' | 'plus' | 'mail'
  | 'debug-alt' | 'debug-continue' | 'debug-step-over' | 'debug-step-into'

export const GLYPHS: Record<GlyphName, ReactNode> = {
  sites: (
    <path d="M3.5 8.2a2.7 2.7 0 0 1 2.7-2.7h3.4l2 2h6.2a2.7 2.7 0 0 1 2.7 2.7v7.1a2.7 2.7 0 0 1-2.7 2.7H6.2a2.7 2.7 0 0 1-2.7-2.7z" />
  ),
  install: (
    <>
      <path d="M12 3.5v10.5" />
      <path d="m7.8 9.8 4.2 4.2 4.2-4.2" />
      <path d="M4.5 16.5v2.2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.2" />
    </>
  ),
  php: (
    <>
      <path d="m8.2 8-4 4 4 4" />
      <path d="m15.8 8 4 4-4 4" />
      <path d="m13.4 4.8-2.8 14.4" />
    </>
  ),
  ports: (
    <>
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 3.2v6.2M12 14.6v6.2M3.2 12h6.2M14.6 12h6.2" />
    </>
  ),
  services: (
    <>
      <rect x="3.5" y="4" width="17" height="6.5" rx="2" />
      <rect x="3.5" y="13.5" width="17" height="6.5" rx="2" />
      <path d="M7 7.25h.01M7 16.75h.01" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h8M16 7h4M4 17h4M12 17h8" />
      <circle cx="14" cy="7" r="2.2" />
      <circle cx="10" cy="17" r="2.2" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
    </>
  ),
  moon: <path d="M20.2 14.1A8.2 8.2 0 0 1 9.9 3.8 8.2 8.2 0 1 0 20.2 14.1Z" />,
  panel: (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="2.2" />
      <path d="M9.2 4v16" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.2" />
      <path d="m15.6 15.6 4 4" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11.2a8 8 0 1 0-.8 4.8" />
      <path d="M20 5.5v5.7h-5.7" />
    </>
  ),
  chevron: <path d="m9.5 6 6 6-6 6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  alert: (
    <>
      <path d="M12 3.8 2.8 20.2h18.4z" />
      <path d="M12 9v5" />
      <path d="M12 17.5h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5" />
      <path d="M12 7.8h.01" />
    </>
  ),
  lock: (
    <>
      <rect x="4.8" y="10.3" width="14.4" height="10" rx="2.4" />
      <path d="M8.3 10.3V7.8a3.7 3.7 0 0 1 7.4 0v2.5" />
    </>
  ),
  unlock: (
    <>
      <rect x="4.8" y="10.3" width="14.4" height="10" rx="2.4" />
      <path d="M8.3 10.3V7.8a3.7 3.7 0 0 1 7.1-1.4" />
    </>
  ),
  play: <path d="M8 5.5 19 12 8 18.5z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  restart: (
    <>
      <path d="M20 11.2a8 8 0 1 0-.8 4.8" />
      <path d="M20 5.5v5.7h-5.7" />
    </>
  ),
  terminal: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
      <path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
      <path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.2 2.3 3.4 5.3 3.4 8.5s-1.2 6.2-3.4 8.5c-2.2-2.3-3.4-5.3-3.4-8.5S9.8 5.8 12 3.5Z" />
    </>
  ),
  spinner: <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" />,
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.2" />
      <path d="m3.9 6.6 8.1 6.2 8.1-6.2" />
    </>
  ),
  'debug-alt': (
    <>
      <circle cx="12" cy="13" r="4.3" />
      <path d="M12 8.7V6M8.5 10.4 6.2 8.1M15.5 10.4l2.3-2.3M7.7 13H4.4M16.3 13h3.3M8.7 16.2l-2.2 2.2M15.3 16.2l2.2 2.2M9.8 5.9 8.4 4.2M14.2 5.9l1.4-1.7" />
    </>
  ),
  'debug-continue': (
    <>
      <path d="M7.5 5.5 16.5 12l-9 6.5z" />
      <path d="M19 5.5v13" />
    </>
  ),
  'debug-step-over': (
    <>
      <path d="M4.5 15.5a7.5 7.5 0 0 1 13.5-4.5" />
      <path d="m14.5 11.5 3.5 -0.5 0.5 -3.5" />
      <circle cx="12" cy="18.5" r="1.5" />
    </>
  ),
  'debug-step-into': (
    <>
      <path d="M12 4.5v9" />
      <path d="m8.2 9.8 3.8 3.8 3.8-3.8" />
      <circle cx="12" cy="18.5" r="1.6" />
    </>
  )
}

/** Iconos de interfaz monocromos; heredan el color del texto. */
export function Glyph({ name, size = 16, className = '', strokeWidth = 1.75 }: {
  name: GlyphName; size?: number; className?: string; strokeWidth?: number
}) {
  return (
    <svg
      className={`glyph ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  )
}
