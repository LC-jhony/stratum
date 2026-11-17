import { decodeFontCharacter, resolveFileIcon, resolveFileIconById, type FileIconThemeJson } from '../theme/fileIconTheme'
import { useFileIconTheme, useProductIconTheme } from '../theme/useTheme'
import { hasProductIcon, type ProductIconThemeJson } from '../theme/productIconTheme'
import { APP_ICONS, GLYPH_ICONS } from './iconMap'
import { GLYPHS, type GlyphName } from './glyphs'
import { LUCIDE } from './lucide'

/**
 * Product icon. Renders the app's minimal SVG glyph (see iconMap.ts, glyphs.tsx / lucide.tsx); if the
 * active product icon theme repoints this id, renders the codicon glyph instead, which the
 * theme's injected CSS re-targets — same override order as VS Code.
 */
export const Icon = ({ id, className = '', style, title }: { id: string; className?: string; style?: React.CSSProperties; title?: string }) => {
  const pi = useProductIconTheme()
  const overridden = !!pi && hasProductIcon(pi.json as ProductIconThemeJson, id)
  const glyphName = overridden ? undefined : (GLYPH_ICONS as Record<string, GlyphName>)[id]
  const name = overridden ? undefined : (APP_ICONS as Record<string, string>)[id]
  const glyph = glyphName ? GLYPHS[glyphName] : name ? LUCIDE[name as keyof typeof LUCIDE] : undefined
  if (glyph) return (
    <svg className={`stratum-icon ${className}`} style={style} aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={glyphName ? 1.75 : 2} strokeLinecap="round" strokeLinejoin="round">{title && <title>{title}</title>}{glyph}</svg>
  )
  return <i className={`codicon codicon-${id} stratum-icon ${className}`} style={style} title={title} aria-hidden />
}

/**
 * File-icon theme ids that mean a concept Stratum also draws natively. Without a theme (the
 * default) the theme id would reach the codicon font and render nothing useful, so it is mapped
 * to the matching product icon. Theme ids present in APP_ICONS resolve through it as well.
 */
const THEME_ICON_FALLBACK: Record<string, string> = {
  database: 'database',
  table: 'table',
  view: 'eye',
  key: 'key',
  index: 'list-ordered',
  folder_database: 'folder',
  folder_database_open: 'folder-opened',
  folder_table: 'folder',
  folder_table_open: 'folder-opened',
}

/** File-type icon from the active file icon theme; falls back to a product icon when no theme (or no match). */
export function FileIcon({ name = '', icon, kind = 'file', fallback = 'file', style }: { name?: string; icon?: string; kind?: 'file' | 'folder' | 'folderExpanded'; fallback?: string; style?: React.CSSProperties }) {
  const active = useFileIconTheme()
  const light = document.documentElement.dataset.theme === 'light'
  const theme = active?.json as FileIconThemeJson | undefined
  // An explicit id wins; the file-name lookup is the fallback for themes that only associate extensions.
  const r = !active ? undefined : icon
    ? resolveFileIconById(theme, active.baseUrl, icon, light) ?? (name ? resolveFileIcon(theme, active.baseUrl, name, kind, light) : undefined)
    : resolveFileIcon(theme, active.baseUrl, name, kind, light)
  if (r?.kind === 'image') return <img className="file-icon" style={style} src={r.url} alt="" draggable={false} />
  if (r?.kind === 'glyph') return <span className="file-icon glyph" style={{ fontFamily: r.fontFamily, color: r.color, ...style }}>{decodeFontCharacter(r.char)}</span>
  const themed = icon ? THEME_ICON_FALLBACK[icon] ?? (icon in APP_ICONS ? icon : undefined) : undefined
  const id = kind === 'folder' ? 'folder' : kind === 'folderExpanded' ? 'folder-opened' : fallback !== 'file' ? fallback : themed ?? fallback
  return <Icon id={id} style={style} />
}
