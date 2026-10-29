import { describe, expect, it } from 'vitest'
import { cssPalette, exportPalette, renderErdSvg, type ErdLayout, type ErdNode } from '../src/renderer/src/erd/erd'
import type { ErdPalette } from '../src/renderer/src/erd/erd'

const node = (n: number, kind: 'table' | 'view' = 'table'): ErdNode => ({
  id: `public.t${n}`, schema: 'public', name: `t${n}`, kind,
  columns: [{ name: 'id', type: 'int4', pk: true, fk: false, nullable: false }],
  x: n * 10, y: n * 10, width: 190, height: 58,
})
const layout = (nodes: ErdNode[]): ErdLayout => ({ nodes, edges: [], width: 800, height: 600 })
const palette: ErdPalette = {
  bg: '#fff', card: '#fff', header: '#eee', border: '#ccc', text: '#111', muted: '#666',
  accent: '#06f', pk: '#b70', fk: '#07a', line: '#999', shadow: 'rgba(0,0,0,.18)',
  font: 'system-ui', mono: 'monospace',
}

describe('ERD rendering', () => {
  it('draws views with a dashed border and keeps the VIEW label', () => {
    const svg = renderErdSvg(layout([node(1), node(2, 'view')]), palette)
    expect(svg).toContain('<g class="node view" data-id="public.t2"')
    expect(svg).toContain('.view .card{stroke-dasharray:5 3}')
    expect(svg).toContain('>VIEW</text>')
  })

  it('adds the card shadow only while the diagram is reasonably small', () => {
    expect(renderErdSvg(layout([node(1)]), palette)).toContain(' class="shadows"')
    expect(renderErdSvg(layout(Array.from({ length: 150 }, (_v, i) => node(i))), palette)).toContain(' class="shadows"')
    const big = renderErdSvg(layout(Array.from({ length: 151 }, (_v, i) => node(i))), palette)
    expect(big).not.toContain(' class="shadows"')
    expect(big).not.toContain('filter:drop-shadow')
  })

  it('uses color-mix for the live shadow and a literal color for file exports', () => {
    expect(cssPalette().shadow).toContain('color-mix')
    expect(exportPalette().shadow).toBe('rgba(0,0,0,.18)')
    const svg = renderErdSvg(layout([node(1)]), { ...palette, shadow: cssPalette().shadow })
    expect(svg).toContain('drop-shadow(0 1px 2.5px color-mix(in srgb, #000 22%, transparent))')
  })

  it('escapes palette values that land in attributes and the style block', () => {
    const svg = renderErdSvg(layout([node(1)]), { ...palette, accent: '"><script>alert(1)</script>' })
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&quot;&gt;&lt;script&gt;')
  })
})
