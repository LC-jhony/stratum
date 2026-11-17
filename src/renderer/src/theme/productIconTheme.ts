import { assetUrl, cssUrl } from './fileIconTheme'

/** VS Code product icon theme: https://code.visualstudio.com/api/extension-guides/product-icon-theme */
export interface ProductIconThemeJson {
  fonts?: { id: string; src: { path: string; format: string }[]; weight?: string; style?: string }[]
  iconDefinitions: Record<string, { fontCharacter: string; fontId?: string } | string>
}

const resolve = (t: ProductIconThemeJson, id: string, depth = 0): { fontCharacter: string; fontId?: string } | undefined => {
  const d = t.iconDefinitions[id]
  if (typeof d === 'string') return depth < 5 ? resolve(t, d, depth + 1) : undefined // alias
  return d
}

/** Theme ids and formats end up in CSS declarations; keep them to characters that cannot break out. */
const cssIdent = (value: string): string => value.replace(/[^\w-]/g, '') || 'default'
const cssKeyword = (value: string | undefined, fallback: string): string => (value ?? '').replace(/[^\w-]/g, '') || fallback

/** A trailing odd backslash would escape the closing quote of `content:"…"`. */
function cssContent(value: string): string | undefined {
  const clean = value.replace(/["\n\r\0]/g, '')
  const trailing = clean.match(/\\+$/)?.[0].length ?? 0
  return trailing % 2 === 0 ? clean : undefined
}

/** True when the theme repoints this id to a glyph the emitted CSS can safely carry. */
export const hasProductIcon = (t: ProductIconThemeJson, id: string): boolean => {
  const char = resolve(t, id)?.fontCharacter
  return char !== undefined && cssContent(char) !== undefined
}

/**
 * Produces CSS that re-points `.codicon-<id>` glyphs at the theme's font/char.
 * Icons the theme doesn't define keep the built-in fallback glyph, same as VS Code.
 */
export function productIconCss(t: ProductIconThemeJson, baseUrl: string): string {
  const fonts = t.fonts ?? []
  const faces = fonts.map((font) => {
    const sources = font.src
      .map((source) => {
        const url = assetUrl(baseUrl, source.path)
        if (!url) return ''
        const format = source.format.replace(/[^\w-]/g, '')
        return `url('${cssUrl(url)}')${format ? ` format('${format}')` : ''}`
      })
      .filter(Boolean)
    if (!sources.length) return ''
    return `@font-face{font-family:'stratum-pi-${cssIdent(font.id)}';src:${sources.join(',')};font-weight:${cssKeyword(font.weight, 'normal')};font-style:${cssKeyword(font.style, 'normal')}}`
  }).filter(Boolean)
  const rules: string[] = []
  const seen = new Set<string>()
  for (const id of Object.keys(t.iconDefinitions)) {
    const d = resolve(t, id)
    if (!d?.fontCharacter || seen.has(id)) continue
    seen.add(id)
    const fam = `stratum-pi-${cssIdent(d.fontId ?? fonts[0]?.id ?? 'default')}`
    const char = cssContent(d.fontCharacter)
    if (char === undefined) continue
    rules.push(`.codicon-${id.replace(/[^\w-]/g, '\\$&')}::before{content:"${char}";font-family:'${fam}',codicon}`)
  }
  return [...faces, ...rules].join('\n')
}
