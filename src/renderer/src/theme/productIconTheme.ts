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

/** True when the theme repoints this id to a glyph (alias-resolved, same rule as the emitted CSS). */
export const hasProductIcon = (t: ProductIconThemeJson, id: string): boolean => !!resolve(t, id)?.fontCharacter

/**
 * Produces CSS that re-points `.codicon-<id>` glyphs at the theme's font/char.
 * Icons the theme doesn't define keep the built-in fallback glyph, same as VS Code.
 */
export function productIconCss(t: ProductIconThemeJson, baseUrl: string): string {
  const fonts = t.fonts ?? []
  const face = fonts.map((f) => `@font-face{font-family:'stratum-pi-${f.id}';src:${f.src.map((s) => `url('${new URL(s.path, baseUrl).href}') format('${s.format}')`).join(',')};font-weight:${f.weight ?? 'normal'};font-style:${f.style ?? 'normal'}}`)
  const rules: string[] = []
  const seen = new Set<string>()
  for (const id of Object.keys(t.iconDefinitions)) {
    const d = resolve(t, id)
    if (!d?.fontCharacter || seen.has(id)) continue
    seen.add(id)
    const fam = `stratum-pi-${d.fontId ?? fonts[0]?.id ?? 'default'}`
    rules.push(`.codicon-${id.replace(/[^\w-]/g, '\\$&')}::before{content:"${d.fontCharacter.replace(/"/g, '')}";font-family:'${fam}',codicon}`)
  }
  return [...face, ...rules].join('\n')
}
