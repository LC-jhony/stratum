import { useSyncExternalStore } from 'react'
import { themes } from '../theme/themeManager'
import { resolveFileIcon } from '../theme/fileIconTheme'
import { hasProductIcon, type ProductIconThemeJson } from '../theme/productIconTheme'
import { APP_ICONS } from './iconMap'
import { LUCIDE } from './lucide'

/**
 * Product icon. Renders the app's minimal SVG glyph (see iconMap.ts / lucide.tsx); if the
 * active product icon theme repoints this id, renders the codicon glyph instead, which the
 * theme's injected CSS re-targets — same override order as VS Code.
 */
export const Icon = ({ id, className = '', style, title }: { id: string; className?: string; style?: React.CSSProperties; title?: string }) => {
  const pi = useSyncExternalStore(themes.subscribe.bind(themes), () => themes.active.productIcon)
  const name = pi && hasProductIcon(pi.json as ProductIconThemeJson, id) ? undefined : (APP_ICONS as Record<string, string>)[id]
  const glyph = name ? LUCIDE[name as keyof typeof LUCIDE] : undefined
  if (glyph) return (
    <svg className={`stratum-icon ${className}`} style={style} aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">{title && <title>{title}</title>}{glyph}</svg>
  )
  return <i className={`codicon codicon-${id} stratum-icon ${className}`} style={style} title={title} aria-hidden />
}

/** File-type icon from the active file icon theme; falls back to a product icon when no theme (or no match). */
export function FileIcon({ name, kind = 'file', fallback = 'file' }: { name: string; kind?: 'file' | 'folder' | 'folderExpanded'; fallback?: string }) {
  const active = useSyncExternalStore(themes.subscribe.bind(themes), () => themes.active.fileIcon)
  const light = document.documentElement.dataset.theme === 'light'
  const r = active ? resolveFileIcon(active.json as never, active.baseUrl, name, kind, light) : undefined
  if (r?.kind === 'image') return <img className="file-icon" src={r.url} alt="" draggable={false} />
  if (r?.kind === 'glyph') return <span className="file-icon glyph" style={{ fontFamily: r.fontFamily, color: r.color }}>{JSON.parse(`"${r.char.replace(/"/g, '')}"`)}</span>
  return <Icon id={kind === 'file' ? fallback : kind === 'folder' ? 'folder' : 'folder-opened'} />
}
