/** VS Code file icon theme: https://code.visualstudio.com/api/extension-guides/file-icon-theme */
interface IconDefinition { iconPath?: string; fontCharacter?: string; fontColor?: string; fontId?: string; fontSize?: string }
interface Associations {
  file?: string; folder?: string; folderExpanded?: string; rootFolder?: string; rootFolderExpanded?: string
  fileExtensions?: Record<string, string>; fileNames?: Record<string, string>
  folderNames?: Record<string, string>; folderNamesExpanded?: Record<string, string>; languageIds?: Record<string, string>
}
export interface FileIconThemeJson extends Associations {
  iconDefinitions: Record<string, IconDefinition>
  fonts?: { id: string; src: { path: string; format: string }[]; weight?: string; style?: string; size?: string }[]
  light?: Associations; highContrast?: Associations
}
export type ResolvedIcon = { kind: 'image'; url: string } | { kind: 'glyph'; char: string; color?: string; fontFamily: string } | undefined

const EXT_LANG: Record<string, string> = { sql: 'sql', json: 'json', md: 'markdown', ts: 'typescript', js: 'javascript', py: 'python', csv: 'csv', xml: 'xml', yml: 'yaml', yaml: 'yaml' }

/** Theme ids end up in CSS declarations; keep them to characters that cannot break out. */
const cssIdent = (value: string): string => value.replace(/[^\w-]/g, '') || 'default'

/** CSS keyword (font weight/style): a theme must not be able to close the declaration. */
const cssKeyword = (value: string | undefined, fallback: string): string => (value ?? '').replace(/[^\w-]/g, '') || fallback

const CSS_URL_ESCAPES: Record<string, string> = {
  "'": '%27', '"': '%22', '\\': '%5C', '\n': '%0A', '\r': '%0D', '\0': '%00',
}

/** Quotes a URL for a CSS `url('…')` without letting a theme path inject a declaration. */
export const cssUrl = (href: string): string => href.replace(/['"\\\n\r\0]/g, (char) => CSS_URL_ESCAPES[char] ?? '')

/**
 * Resolves a theme asset only inside the dedicated scheme. A third-party theme must not be able
 * to point an `<img>` or `@font-face` at `file:`, `http:` or a malformed URL.
 */
export function assetUrl(baseUrl: string, relative: string): string | undefined {
  try {
    const url = new URL(relative, baseUrl)
    return url.protocol === 'stratum-asset:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/**
 * Decodes a VS Code `fontCharacter`. Themes store CSS escapes (`\e001`, `\ea60`, `\1f600`), which
 * are not JSON escapes: `JSON.parse` rejects them. A literal character passes through unchanged.
 */
export function decodeFontCharacter(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char !== '\\') { out += char; continue }
    const rest = value.slice(i + 1)
    const hex = rest.match(/^[0-9a-f]{1,6}/i)
    if (hex) {
      const code = Number.parseInt(hex[0], 16)
      if (code > 0 && code <= 0x10ffff) out += String.fromCodePoint(code)
      i += hex[0].length
      // One optional whitespace terminates a CSS escape.
      if (/[ \t\n]/.test(value[i + 1] ?? '')) i++
      continue
    }
    if (rest[0] === '\n') { i++; continue }
    if (rest.length > 0) { out += rest[0]; i++ }
  }
  return out
}

const MAX_ICON_CACHE = 4096
const iconCache = new WeakMap<object, Map<string, ResolvedIcon | null>>()

function cached(theme: FileIconThemeJson, key: string, compute: () => ResolvedIcon): ResolvedIcon {
  let map = iconCache.get(theme)
  if (!map) { map = new Map(); iconCache.set(theme, map) }
  if (map.has(key)) return map.get(key) ?? undefined
  const value = compute()
  if (map.size >= MAX_ICON_CACHE) map.clear()
  map.set(key, value ?? null)
  return value
}

export function pickIconId(t: FileIconThemeJson, name: string, kind: 'file' | 'folder' | 'folderExpanded' | 'root', lightMode: boolean): string | undefined {
  const sets: Associations[] = lightMode && t.light ? [t.light, t] : [t]
  const lower = name.toLowerCase()
  for (const a of sets) {
    if (kind === 'file') {
      if (a.fileNames?.[lower]) return a.fileNames[lower]
      // `a.b.c` tries "b.c" then "c" (longest suffix wins), exactly like VS Code.
      for (let i = lower.indexOf('.'); i >= 0; i = lower.indexOf('.', i + 1)) { const ext = lower.slice(i + 1); if (ext && a.fileExtensions?.[ext]) return a.fileExtensions[ext] }
      const lang = EXT_LANG[lower.split('.').pop() ?? '']
      if (lang && a.languageIds?.[lang]) return a.languageIds[lang]
    } else if (kind === 'folderExpanded') {
      const id = a.folderNamesExpanded?.[lower] ?? a.folderNames?.[lower]; if (id) return id
    } else if (kind === 'folder') {
      const id = a.folderNames?.[lower]; if (id) return id
    }
  }
  const base = sets[0], root = t
  const dflt = kind === 'file' ? base.file ?? root.file : kind === 'folder' ? base.folder ?? root.folder : kind === 'folderExpanded' ? base.folderExpanded ?? root.folderExpanded ?? base.folder ?? root.folder : base.rootFolder ?? root.rootFolder ?? root.folder
  return dflt
}

export function resolveFileIcon(t: FileIconThemeJson | undefined, baseUrl: string, name: string, kind: 'file' | 'folder' | 'folderExpanded' | 'root', lightMode = false): ResolvedIcon {
  if (!t) return undefined
  return cached(t, `n|${baseUrl}|${lightMode ? 1 : 0}|${kind}|${name}`, () => {
    const id = pickIconId(t, name, kind, lightMode)
    return resolveFileIconById(t, baseUrl, id, lightMode)
  })
}

/**
 * Resolve an explicit icon id (a table, a data source, a folder kind). Light mode prefers the
 * theme's `__id` twin — the same convention its `light` association maps use — and falls back to
 * the base definition when the theme ships a single flavour.
 */
export function resolveFileIconById(t: FileIconThemeJson | undefined, baseUrl: string, id: string | undefined, lightMode = false): ResolvedIcon {
  if (!t || !id) return undefined
  return cached(t, `i|${baseUrl}|${lightMode ? 1 : 0}|${id}`, () => {
    const key = lightMode && !id.startsWith('__') && t.iconDefinitions[`__${id}`] ? `__${id}` : id
    const def = t.iconDefinitions[key]
    if (!def) return undefined
    if (def.iconPath) {
      const url = assetUrl(baseUrl, def.iconPath)
      return url ? { kind: 'image', url } : undefined
    }
    if (def.fontCharacter) return { kind: 'glyph', char: def.fontCharacter, color: def.fontColor, fontFamily: `stratum-fi-${cssIdent(def.fontId ?? t.fonts?.[0]?.id ?? 'default')}` }
    return undefined
  })
}

export function fileIconFontCss(t: FileIconThemeJson, baseUrl: string): string {
  return (t.fonts ?? []).map((font) => {
    const sources = font.src
      .map((source) => {
        const url = assetUrl(baseUrl, source.path)
        if (!url) return ''
        const format = source.format.replace(/[^\w-]/g, '')
        return `url('${cssUrl(url)}')${format ? ` format('${format}')` : ''}`
      })
      .filter(Boolean)
    if (!sources.length) return ''
    return `@font-face{font-family:'stratum-fi-${cssIdent(font.id)}';src:${sources.join(',')};font-weight:${cssKeyword(font.weight, 'normal')};font-style:${cssKeyword(font.style, 'normal')}}`
  }).filter(Boolean).join('\n')
}
