import type { ReactNode } from 'react'

/**
 * Driver marks + the glyphs that only the data-source dialog uses (floppy, tools, socks, proxy).
 * Brand logos keep their real colours — they are identifiers, not theme-able UI; the generic UI
 * glyphs paint with currentColor so they follow the button they sit in.
 */
const GLYPHS: Record<string, ReactNode> = {
  mysql: (
    <>
      <path fill="#0E7C99" d="M3.4 18.7c.5-2.7 1.8-4.9 3.9-6.5 2-1.5 4.3-2.3 6.9-2.4l-2.1 2.6c2.4-.7 4.8-.8 7.2-.3-1.6.8-3.1 1.9-4.3 3.2 1.9-.3 3.8-.2 5.7.5-2.7.5-5.1 1.7-7.2 3.3-1.2 1-2.2 2.1-3 3.4-.2.3-.5.5-.9.5H3.9c-.4 0-.6-.4-.5-.7z"/>
      <path fill="#0E7C99" d="M15.4 9.6c1-2.4 2.6-4.3 4.9-5.7-.5 1.3-.9 2.6-.9 4 0 1.1.2 2.2.6 3.2-1.8-.3-3.3-.9-4.6-1.5z"/>
    </>
  ),
  mariadb: (
    <>
      <path fill="none" stroke="#2FB3A6" strokeWidth="2.8" strokeLinecap="round" d="M16.8 3.9c1.5.7 2.3 1.9 2.3 3.4 0 1.2-.6 2.2-1.7 2.9.5 1.2.6 2.4.2 3.7-.4 1.7-1.5 2.9-3.1 3.5-1.6.6-3.2.5-4.7-.3-1.5-.8-2.4-2.1-2.6-3.9-.2-1.6.4-3 1.6-4.2 1.1-1.1 1.8-2.4 2.1-3.9.2-1.1.1-2.2-.2-3.3 1.5.3 2.7 1 3.6 2.1z"/>
      <circle cx="16.4" cy="5.1" r="1.5" fill="#2FB3A6"/>
      <path fill="#0E8C82" d="M17.8 4.2l2.9-1.1-1.9 2.5z"/>
    </>
  ),
  postgres: (
    <>
      <path fill="#4A7FB0" d="M13 2.8c2.6 0 4.7 1.4 5.7 3.7.6 1.4 1 2.9 1.1 4.5.1 1.5 0 3-.4 4.5-.3 1.5-.8 2.8-1.5 3.9-.4.6-.8 1-1.2.9-.4-.1-.6-.5-.7-1.2l-.4-2.7c-.2-1.1-.5-2-1-2.6-.5-.7-1.3-1-2.2-1s-1.7.3-2.2 1c-.5.6-.8 1.5-1 2.6l-.4 2.7c-.1.7-.3 1.1-.7 1.2-.4.1-.8-.3-1.2-.9-.7-1.1-1.2-2.4-1.5-3.9-.4-1.5-.5-3-.4-4.5.1-1.6.5-3.1 1.1-4.5 1-2.3 3.1-3.7 5.7-3.7z"/>
      <path fill="#2F5F8F" d="M7.7 6.5C6.5 5.7 5.2 5.5 4 6c1 .3 1.9.9 2.5 1.8z"/>
      <circle cx="14.8" cy="8.1" r="1.05" fill="#fff"/>
    </>
  ),
  sqlite: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="4" fill="#0F80CC"/>
      <path d="M16.2 6.4c.6 3.1-.1 5.8-2 8.2-1.3 1.6-2.9 2.6-4.8 3.1.5-1.9 1.3-3.5 2.5-4.9 1.4-1.6 2.8-3.4 4.3-6.4z" fill="#fff"/>
      <path d="M7.1 17.2c1.1-.6 2-1.5 2.7-2.6.7-1.1 1.1-2.2 1.3-3.5-1.5.7-2.7 1.8-3.5 3.2-.5.9-.7 1.9-.5 2.9z" fill="#DCEBF7"/>
    </>
  ),
  sqlserver: (
    <>
      <path fill="#C1272D" d="M12.6 2.9c2.5 1.8 4.4 4.1 5.5 6.9 1 2.3 1.4 4.7 1.2 7.2-1.7-1.6-3.7-2.9-5.9-3.7-1.8-.7-3.6-1-5.4-1 .5-2.1 1.4-4 2.6-5.7 1.5-1.9 3.1-3.2 5.6-3.8z"/>
      <path fill="#D9DBDD" d="M8.9 13.4c1.8.2 3.5.6 5 1.4 1.9.9 3.6 2.1 5 3.7-1.7 1-3.5 1.6-5.4 1.8-1.7.2-3.4 0-5-.4.5-1.2.8-2.3 1-3.5 0-1-.2-2-.6-3z"/>
      <circle cx="16.2" cy="7.2" r="1.3" fill="#D9DBDD"/>
      <path fill="#7E1116" d="M11.3 15.5l1.7.7-.5 2.7-1.4-.3z"/>
    </>
  ),
  db2: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3.5" fill="#1F7A3D"/>
      <rect x="3" y="3" width="18" height="8" rx="3.5" fill="#2E9E52"/>
      <text x="12" y="16.6" fontFamily="Segoe UI, Inter, sans-serif" fontSize="7.4" fontWeight="700" fill="#fff" textAnchor="middle">db2</text>
    </>
  ),
  oracle: (
    <>
      <rect x="2" y="6.6" width="20" height="10.8" rx="5.4" fill="#C74634"/>
      <ellipse cx="12" cy="12" rx="6.1" ry="2.9" fill="#fff" opacity=".92"/>
    </>
  ),
  kingbase: (
    <>
      <path fill="#D02C2C" d="M4 3.4h4.3v6.1L13 3.4h5.4l-5.8 7.2 6.3 10h-5.3l-3.9-6.6-1.4 1.6v5H4z"/>
      <path fill="#8E1B1B" d="M17.1 14.6l2.9 6h-3.2l-2.2-4.5z"/>
    </>
  ),
  clickhouse: (
    <>
      <rect x="3" y="3" width="4" height="4" rx="1" fill="#F2D06B"/>
      <rect x="3" y="8.4" width="4" height="12.6" rx="1" fill="#FFCC01"/>
      <rect x="8.6" y="3" width="4" height="18" rx="1" fill="#FFCC01"/>
      <rect x="14.2" y="3" width="4" height="18" rx="1" fill="#FFCC01"/>
      <rect x="19.8" y="3" width="1.6" height="18" rx=".8" fill="#E5B400"/>
    </>
  ),
  jdbc: (
    <>
      <path fill="#F0932B" d="M10.4 2.6c1.1 1.2 1.4 2.6.9 4.2-.4 1.3-1.3 2.3-2.6 3 .7-.9 1.2-1.9 1.4-3 .2-1.4-.1-2.7-.9-3.9.5-.2.9-.3 1.2-.3z"/>
      <path fill="#5382A1" d="M4.6 11.2h11.2c-.2 3.5-1.5 6.2-3.9 8.1-1.2 1-2.6 1.5-4.2 1.5-1.5 0-2.6-.5-3.3-1.6 1.4.3 2.7.1 3.8-.6-1-.5-1.7-1.3-2.1-2.4-.4-1.1-.4-2.4.1-3.7.1-.6.2-1.4.4-2.3z"/>
      <path fill="#F0932B" d="M6.6 21.6c1.5.5 3 .5 4.5 0 1.6-.5 2.6-1.6 3-3.2.4 1.9-.2 3.3-1.6 4.2-1.5 1-3.1 1.2-4.9.6-.5-.2-.8-.7-1-1.6z"/>
    </>
  ),
  ssh: (
    <>
      <circle cx="15.6" cy="8.4" r="3.9" fill="none" stroke="#E9C13C" strokeWidth="2.6"/>
      <path fill="#8A9099" d="M12.9 11.1L4.7 19.3v-2.9l1.2-1.2v-2.2l1.2-1.2h2.2l1.2-1.2h2.2z"/>
    </>
  ),
  docker: (
    <>
      <path fill="#2496ED" d="M12.6 6.4h2.9v2.7h-2.9zm3.5 0h2.9v2.7h-2.9zm-7 0h2.9v2.7H9.1zm-3.6 3.3h2.9v2.7H5.5zm3.6 0h2.9v2.7H9.1zm3.5 0h2.9v2.7h-2.9zm3.5 0h2.9v2.7h-2.9z"/>
      <path fill="#2496ED" d="M21.6 11.2c-.7-.5-1.9-.6-2.9-.4-.2-1.2-.9-2.2-1.8-2.9l-.5-.4-.4.5c-.5.7-.8 1.7-.7 2.6 0 .4.1.8.3 1.2-.3.2-.8.4-1.5.4H2.3l-.1.5c-.2 1.5.1 3 .9 4.2 1 1.3 2.5 1.9 4.5 1.9 4.4 0 7.8-1.9 9.5-5.6 1 0 2.1-.2 2.7-1.2l.2-.3-.4-.5z"/>
    </>
  ),
  redis: (
    <>
      <path fill="#A41E11" d="M3 9.4l9-3.4 9 3.4-9 3.4z"/>
      <path fill="#DC382D" d="M3 10.4l9 3.4 9-3.4v3.2l-9 3.4-9-3.4z"/>
      <path fill="#A41E11" d="M3 15l9 3.4L21 15v3.3l-9 3.4-9-3.4z"/>
    </>
  ),
  elastic: (
    <>
      <path fill="#FEC514" d="M5.6 5.4A9 9 0 0 1 12 3c3.1 0 5.9 1.6 7.5 4H4.6c.3-.6.6-1.1 1-1.6z"/>
      <path fill="#00BFB3" d="M19.6 17a9 9 0 0 1-7.6 4c-3.3 0-6.2-1.8-7.8-4.5h15.4z"/>
      <path fill="#343741" d="M3.2 11.4h17.6v2.5H3.2z"/>
      <path fill="#FEC514" d="M4.9 8.6h16.4c.2.6.3 1.3.3 2H4.2c.1-.7.3-1.4.7-2z" opacity=".85"/>
      <path fill="#00BFB3" d="M4.4 13.9h17c-.1.7-.3 1.4-.6 2H5.6c-.5-.6-.9-1.3-1.2-2z" opacity=".85"/>
    </>
  ),
  mongodb: (
    <>
      <path fill="#13AA52" d="M12 2c3.3 2.9 5.1 6.3 5.1 10.1 0 3.1-1.6 5.9-4.2 7.7l-.9.6V2z"/>
      <path fill="#3F9C35" d="M12 2v18.4l-.9-.6c-2.6-1.8-4.2-4.6-4.2-7.7C6.9 8.3 8.7 4.9 12 2z"/>
      <path fill="#B8C4C2" d="M12 19.2v2.8c-.4-.8-.9-1.4-1.4-1.9.5-.4 1-.7 1.4-.9z"/>
    </>
  ),
  s3: (
    <>
      <path fill="#E25444" d="M4.6 4.6h14.8l-1.7 14.1c0 .4-.3.6-.6.5l-4.8-.8c-.2 0-.4 0-.6 0l-4.8.8c-.3.1-.6-.1-.6-.5z"/>
      <path fill="#B93B2C" d="M12 7.6l5.6 1.5-1.2 9.6c0 .4-.3.6-.6.5L12 18.4z" opacity=".55"/>
      <path fill="#B93B2C" d="M3.6 3.3h16.8c.5 0 .7.4.6.8l-.5 1.4H3.5L3 4.1c-.1-.4.1-.8.6-.8z"/>
      <circle cx="7.6" cy="1.6" r="1.3" fill="#E25444"/>
    </>
  ),
  ftp: (
    <>
      <path fill="#E8B93C" d="M3 6.2c0-1 .8-1.8 1.8-1.8h4.1l1.8 2h8.5c1 0 1.8.8 1.8 1.8v9.4c0 1-.8 1.8-1.8 1.8H4.8c-1 0-1.8-.8-1.8-1.8z"/>
      <path fill="#F6D07A" d="M3 9.6h18v8c0 1-.8 1.8-1.8 1.8H4.8c-1 0-1.8-.8-1.8-1.8z" opacity=".85"/>
    </>
  ),
  kafka: (
    <>
      <circle cx="12" cy="12" r="2.7" fill="none" stroke="#8B9198" strokeWidth="1.9"/>
      <circle cx="18.4" cy="7.4" r="2.4" fill="none" stroke="#8B9198" strokeWidth="1.9"/>
      <circle cx="18.4" cy="16.6" r="2.4" fill="none" stroke="#8B9198" strokeWidth="1.9"/>
      <circle cx="7.6" cy="12" r="2.4" fill="none" stroke="#8B9198" strokeWidth="1.9"/>
      <path d="M9.9 10.6l6.4-2.3M9.9 13.4l6.4 2.3M5.2 12h3.9" stroke="#8B9198" strokeWidth="1.6" fill="none"/>
    </>
  ),
  rabbitmq: (
    <>
      <path fill="#FF6600" d="M12 3.4c3.6 0 6.5 2.6 6.5 5.9 0 1.2-.4 2.3-1.1 3.3l.9 4.1c.1.4-.2.8-.6.8h-2.3c-.3 0-.5-.1-.6-.4l-.5-1.8c-.4.1-.8.1-1.3.1h-2c-.4 0-.9 0-1.3-.1l-.5 1.8c-.1.3-.3.4-.6.4H5.3c-.4 0-.7-.4-.6-.8l.9-4.1c-.7-1-1.1-2.1-1.1-3.3 0-3.3 2.9-5.9 6.5-5.9z"/>
      <circle cx="12" cy="8.6" r="2.7" fill="#fff" opacity=".92"/>
    </>
  ),
  cassandra: (
    <>
      <path fill="#4FA3D1" d="M12 4.6c3.9 0 7.1 2.7 7.1 6.1 0 1.9-1.1 3.6-2.8 4.7.6-.9.9-1.9.9-3 0-2.6-2.3-4.7-5.2-4.7S6.8 9.8 6.8 12.4c0 1.1.3 2.1.9 3-1.7-1.1-2.8-2.8-2.8-4.7 0-3.4 3.2-6.1 7.1-6.1z"/>
      <circle cx="12" cy="12.4" r="2.6" fill="#4FA3D1"/>
      <path fill="#4FA3D1" d="M9.5 15.6c1.1 1.4 1.2 3 .4 4.8-1.3-.6-2-1.7-2-3.2 0-.6.1-1.3.4-2z" opacity=".85"/>
    </>
  ),
  more: (
    <>
      <rect x="3" y="3" width="8.2" height="8.2" rx="2" fill="#E8912A"/>
      <rect x="12.8" y="3" width="8.2" height="8.2" rx="2" fill="#F7C266"/>
      <rect x="3" y="12.8" width="8.2" height="8.2" rx="2" fill="#E8912A"/>
      <rect x="12.8" y="12.8" width="8.2" height="8.2" rx="2" fill="#E8912A"/>
    </>
  ),
  socks: (
    <>
      <path fill="#E8912A" d="M6.2 3h3v7.6c0 1.6.7 2.9 2 4l2.6 2.2c1.1.9 1.3 2 .6 3-.7 1-2 1.2-3.1.4l-3.2-2.6c-1.3-1.1-1.9-2.5-1.9-4.2z"/>
      <path fill="#B86E12" d="M13.4 3h3v6.8c0 1.2.5 2.2 1.5 3.1l1.7 1.5c1 .9 1.1 2 .4 3-.7.9-1.9 1.1-2.9.3l-2.4-2c-.9-.8-1.3-1.7-1.3-2.9z"/>
    </>
  ),
  http: (
    <>
      <path fill="none" stroke="#4FA3D1" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" d="M10 7.5H7.5a4.5 4.5 0 0 0 0 9H10M14 7.5h2.5a4.5 4.5 0 0 1 0 9H14"/>
      <path fill="#4FA3D1" d="M13.6 3.4l4.6 4.4-4.6 4.4V9.4h-3.2V6.8h3.2z" opacity=".01"/>
    </>
  ),
  tools: (
    <>
      <path fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" d="M6.4 3.6l3.2 3.2-2 2L4.4 5.6c-.5 1.6 0 3.5 1.3 4.8 1.4 1.4 3.5 1.8 5.2 1.1l6 6c.6.6 1.5.6 2.1 0 .6-.6.6-1.5 0-2.1l-6-6c.7-1.7.3-3.8-1.1-5.2-1.3-1.3-3.2-1.8-4.8-1.3z"/>
    </>
  ),
  save: (
    <>
      <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" d="M4.8 3.6h11.4l3 3v13.8H4.8z"/>
      <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" d="M8.2 3.6v5.6h7V3.6M8.2 20.4v-6.6h7.6v6.6"/>
    </>
  ),
}

export function DbIcon({ name, size = 16, className = '' }: { name: string; size?: number; className?: string }) {
  const glyph = GLYPHS[name]
  if (!glyph) return null
  return (
    <svg className={`ds-ico ${className}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {glyph}
    </svg>
  )
}

/** Stacked-cylinder mark from the reference design (never gets a theme colour — it is the brand). */
export function DbLogo({ size = 60 }: { size?: number }) {
  return (
    <svg className="ds-logo" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="ds-cyl-blue" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4E86CB" />
          <stop offset="1" stopColor="#2F5A96" />
        </linearGradient>
        <linearGradient id="ds-cyl-warm" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F7B32B" />
          <stop offset=".45" stopColor="#EE8B1E" />
          <stop offset="1" stopColor="#C9451F" />
        </linearGradient>
      </defs>
      <g transform="translate(27 7)">
        <path d="M0 6a17 6 0 0 1 34 0v34a17 6 0 0 1-34 0z" fill="url(#ds-cyl-blue)" />
        <ellipse cx="17" cy="6" rx="17" ry="6" fill="#5B93D6" />
        <path d="M0 17.5a17 6 0 0 0 34 0v2.5a17 6 0 0 1-34 0z" fill="#2B5288" />
        <path d="M0 29.5a17 6 0 0 0 34 0v2.5a17 6 0 0 1-34 0z" fill="#2B5288" />
      </g>
      <g transform="translate(4 15)">
        <path d="M0 6a17 6 0 0 1 34 0v34a17 6 0 0 1-34 0z" fill="url(#ds-cyl-warm)" />
        <ellipse cx="17" cy="6" rx="17" ry="6" fill="#FBC65A" />
        <path d="M0 17.5a17 6 0 0 0 34 0v2.5a17 6 0 0 1-34 0z" fill="#C25A18" />
        <path d="M0 29.5a17 6 0 0 0 34 0v2.5a17 6 0 0 1-34 0z" fill="#A3401A" />
      </g>
    </svg>
  )
}
