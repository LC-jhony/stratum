import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkNode } from 'elkjs/lib/elk-api'
import type { DatabaseModel, ErdOptions, TableInfo } from '../../../shared/types'

export interface ErdColumn { name: string; type: string; pk: boolean; fk: boolean; nullable: boolean }
export interface ErdNode { id: string; schema: string; name: string; kind: 'table' | 'view'; columns: ErdColumn[]; x: number; y: number; width: number; height: number }
export interface ErdEdge { id: string; from: string; to: string; fromColumn: string; toColumn: string; name: string; d: string; start: Pt; end: Pt; startSide: 1 | -1; endSide: 1 | -1 }
export interface Pt { x: number; y: number }
export interface ErdGraph { nodes: ErdNode[]; edges: Omit<ErdEdge, 'd' | 'start' | 'end' | 'startSide' | 'endSide'>[] }
export interface ErdLayout { nodes: ErdNode[]; edges: ErdEdge[]; width: number; height: number }
export const HEADER_H = 34, ROW_H = 24, PAD = 12, CHAR_W = 7.2, MIN_W = 190
const nodeId = (schema: string, table: string) => `${schema}.${table}`

/** Pure: catalog -> graph. Edges to tables outside the selection are dropped rather than dangling. */
export function buildErdGraph(db: DatabaseModel, opts: ErdOptions = {}): ErdGraph {
  const all = new Map<string, { schema: string; t: TableInfo }>()
  for (const s of db.schemas) {
    if (opts.schemas?.length && !opts.schemas.includes(s.name)) continue
    for (const t of s.tables) { if (t.kind === 'view' && !opts.includeViews) continue; all.set(nodeId(s.name, t.name), { schema: s.name, t }) }
  }
  let keep = new Set(all.keys())
  if (opts.tables?.length) keep = new Set([...keep].filter((id) => opts.tables!.includes(id) || opts.tables!.includes(all.get(id)!.t.name)))
  if (opts.focus) {
    const start = [...all.keys()].find((id) => id === opts.focus!.table || all.get(id)!.t.name === opts.focus!.table)
    const reach = new Set(start ? [start] : [])
    for (let d = 0; d < opts.focus.depth; d++) {
      for (const [id, { schema, t }] of all) for (const fk of t.foreignKeys) {
        const to = nodeId(fk.refSchema || schema, fk.refTable)
        if (reach.has(id) && all.has(to)) reach.add(to)
        if (reach.has(to)) reach.add(id)
      }
    }
    keep = new Set([...keep].filter((id) => reach.has(id)))
  }
  const nodes: ErdNode[] = [], edges: ErdGraph['edges'] = []
  for (const id of keep) {
    const { schema, t } = all.get(id)!
    const fkCols = new Set(t.foreignKeys.flatMap((f) => f.columns))
    const columns = [...t.columns].sort((a, b) => a.ordinal - b.ordinal).map((c) => ({ name: c.name, type: c.dataType, pk: c.isPrimaryKey, fk: fkCols.has(c.name), nullable: c.nullable }))
    const textW = Math.max(t.name.length * 8.4 + 56, ...columns.map((c) => (c.name.length + c.type.length + 4) * CHAR_W + 2 * PAD + 22))
    nodes.push({ id, schema, name: t.name, kind: t.kind, columns, x: 0, y: 0, width: Math.ceil(Math.max(MIN_W, textW)), height: HEADER_H + Math.max(1, columns.length) * ROW_H + 6 })
    for (const fk of t.foreignKeys) {
      const to = nodeId(fk.refSchema || schema, fk.refTable)
      if (!keep.has(to)) continue
      fk.columns.forEach((c, i) => edges.push({ id: `${id}:${fk.name}:${i}`, from: id, to, fromColumn: c, toColumn: fk.refColumns[i] ?? fk.refColumns[0], name: fk.name }))
    }
  }
  return { nodes, edges }
}

const rowY = (n: ErdNode, col: string) => n.y + HEADER_H + Math.max(0, n.columns.findIndex((c) => c.name === col)) * ROW_H + ROW_H / 2

/** Orthogonal connector between two column rows with rounded corners. `sx`/`ex` = +1 leaves/enters on the right edge, -1 on the left. */
function route(a: ErdNode, b: ErdNode, e: ErdGraph['edges'][number]): Pick<ErdEdge, 'd' | 'start' | 'end' | 'startSide' | 'endSide'> {
  const y1 = rowY(a, e.fromColumn), y2 = rowY(b, e.toColumn), R = 8, STUB = 22
  let sx: 1 | -1, ex: 1 | -1
  if (a === b) { sx = 1; ex = 1 }
  else if (a.x + a.width + 2 * STUB <= b.x) { sx = 1; ex = -1 }
  else if (b.x + b.width + 2 * STUB <= a.x) { sx = -1; ex = 1 }
  else { sx = 1; ex = 1 } // overlapping columns: both exit right and rejoin
  const x1 = sx === 1 ? a.x + a.width : a.x, x2 = ex === 1 ? b.x + b.width : b.x
  const p1 = { x: x1, y: y1 }, p2 = { x: x2, y: y2 }
  let d: string
  if (sx !== ex) {
    const gap = Math.abs(x2 - x1), xm = (x1 + x2) / 2 + ((hash(e.id) % 5) - 2) * Math.min(7, gap / 14), dy = Math.sign(y2 - y1), r = Math.min(R, Math.abs(y2 - y1) / 2, Math.abs(xm - x1))
    d = Math.abs(y2 - y1) < 1 ? `M${x1},${y1} H${x2}` : `M${x1},${y1} H${xm - sx * r} Q${xm},${y1} ${xm},${y1 + dy * r} V${y2 - dy * r} Q${xm},${y2} ${xm + sx * r},${y2} H${x2}`
  } else {
    const out = Math.max(x1, x2) + (sx === 1 ? STUB * 1.6 : -STUB * 1.6), xo = sx === 1 ? out : Math.min(x1, x2) - STUB * 1.6, dy = Math.sign(y2 - y1) || 1
    d = `M${x1},${y1} H${xo - sx * R} Q${xo},${y1} ${xo},${y1 + dy * R} V${y2 - dy * R} Q${xo},${y2} ${xo - sx * R},${y2} H${x2}`
  }
  return { d, start: p1, end: p2, startSide: sx, endSide: ex }
}

export async function layoutErd(g: ErdGraph): Promise<ErdLayout> {
  if (!g.nodes.length) return { nodes: [], edges: [], width: 0, height: 0 }
  const elk = new ELK()
  const res = await elk.layout<ElkNode>({
    id: 'root',
    layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': '48', 'elk.layered.spacing.nodeNodeBetweenLayers': '110', 'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP', 'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX', 'elk.padding': '[top=40,left=40,bottom=40,right=40]', 'elk.separateConnectedComponents': 'true', 'elk.spacing.componentComponent': '70' },
    children: g.nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: g.edges.filter((e) => e.from !== e.to).map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  })
  const pos = new Map((res.children ?? []).map((c) => [c.id, c]))
  const nodes = g.nodes.map((n) => ({ ...n, x: Math.round(pos.get(n.id)?.x ?? 0), y: Math.round(pos.get(n.id)?.y ?? 0) }))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const edges = g.edges.map((e) => ({ ...e, ...route(byId.get(e.from)!, byId.get(e.to)!, e) }))
  return { nodes, edges, width: Math.ceil(res.width ?? 0), height: Math.ceil(res.height ?? 0) }
}

export interface ErdPalette { bg: string; card: string; header: string; border: string; text: string; muted: string; accent: string; pk: string; fk: string; line: string; font: string; mono: string }

/** Live palette: CSS variables, so the diagram re-themes instantly with the workbench. */
export const cssPalette = (): ErdPalette => ({
  bg: 'var(--vscode-editor-background)', card: 'var(--vscode-editorWidget-background, var(--vscode-editor-background))',
  header: 'var(--vscode-sideBarSectionHeader-background, var(--vscode-sideBar-background))',
  border: 'var(--vscode-editorWidget-border, var(--vscode-panel-border))', text: 'var(--vscode-editor-foreground)', muted: 'var(--vscode-descriptionForeground)',
  accent: 'var(--vscode-focusBorder)', pk: 'var(--vscode-charts-yellow)', fk: 'var(--vscode-charts-blue)', line: 'var(--vscode-charts-lines, var(--vscode-descriptionForeground))',
  font: `var(--stratum-font, system-ui, sans-serif)`, mono: `var(--stratum-mono, ui-monospace, Menlo, Consolas, monospace)`,
})
/** Resolve CSS variables into literal colors for standalone export. */
export function resolvePalette(p: ErdPalette, cs: CSSStyleDeclaration): ErdPalette {
  const r = (v: string): string => v.replace(/var\((--[\w-]+)(?:,\s*(.*))?\)/g, (_m, n, f) => cs.getPropertyValue(n).trim() || (f ? r(f.replace(/\)$/, '')) : '#888'))
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, r(v)])) as unknown as ErdPalette
}
/** Fixed light palette for file exports: diagrams saved to disk are always light on a white background, whatever the active theme. Fonts stay configurable through the caller. */
export const exportPalette = (fonts?: Pick<ErdPalette, 'font' | 'mono'>): ErdPalette => ({
  bg: '#ffffff', card: '#ffffff', header: '#f3f3f3', border: '#d4d4d4', text: '#24292f', muted: '#6e7681',
  accent: '#005fb8', pk: '#b7791f', fk: '#1976d2', line: '#8c959f',
  font: fonts?.font ?? 'system-ui, sans-serif', mono: fonts?.mono ?? 'ui-monospace, Menlo, Consolas, monospace',
})

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
/** Crow's foot (many) at the FK end: three prongs touch the card edge and converge outward on the connector. */
function crow(p: Pt, side: 1 | -1) { const t = p.x + side * 10; return `M${t},${p.y} L${p.x},${p.y - 6} M${t},${p.y} L${p.x},${p.y} M${t},${p.y} L${p.x},${p.y + 6}` }
/** Double bar (exactly one) at the referenced end. */
function one(p: Pt, side: 1 | -1) { return `M${p.x + side * 8},${p.y - 6} v12 M${p.x + side * 13},${p.y - 6} v12` }
const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h) }

export function renderErdSvg(l: ErdLayout, palette: ErdPalette, o: { showTypes?: boolean; standalone?: boolean; /** false drops the page-filling background rect (transparent export) */ background?: boolean } = {}): string {
  const showTypes = o.showTypes ?? true
  // Resolved font stacks contain double quotes; escape every palette value so attributes and the <style> block stay valid XML.
  const p = Object.fromEntries(Object.entries(palette).map(([k, v]) => [k, esc(v)])) as unknown as ErdPalette
  const edges = l.edges.map((e) => `<g class="edge" data-from="${esc(e.from)}" data-to="${esc(e.to)}"><path d="${e.d}" class="ln"/><path d="${crow(e.start, e.startSide)}" class="ln cf"/><path d="${one(e.end, e.endSide)}" class="ln cf"/><path d="${e.d}" class="hit"/></g>`).join('')
  const nodes = l.nodes.map((n) => {
    const rows = n.columns.map((c, i) => {
      const y = HEADER_H + i * ROW_H + ROW_H / 2
      const mark = c.pk ? `<rect x="${PAD - 1}" y="${y - 4}" width="8" height="8" rx="2" fill="${p.pk}"/>` : c.fk ? `<circle cx="${PAD + 3}" cy="${y}" r="3.5" fill="none" stroke="${p.fk}" stroke-width="1.5"/>` : ''
      return `<g class="row"><text x="${PAD + 17}" y="${y}" dy=".35em" fill="${p.text}" font-size="12.5" ${c.pk ? 'font-weight="600"' : ''}>${esc(c.name)}</text>${showTypes ? `<text x="${n.width - PAD}" y="${y}" dy=".35em" text-anchor="end" fill="${p.muted}" font-size="11" font-family="${p.mono}">${esc(c.type)}${c.nullable || c.pk ? '' : ' •'}</text>` : ''}${mark}</g>`
    }).join('')
    return `<g class="node" data-id="${esc(n.id)}" transform="translate(${n.x},${n.y})"><rect class="card" width="${n.width}" height="${n.height}" rx="9" fill="${p.card}" stroke="${p.border}"/><path d="M0,${HEADER_H} V9 a9,9 0 0 1 9,-9 H${n.width - 9} a9,9 0 0 1 9,9 V${HEADER_H} Z" fill="${p.header}"/><line x1="0" x2="${n.width}" y1="${HEADER_H}" y2="${HEADER_H}" stroke="${p.border}"/><text x="${PAD}" y="${HEADER_H / 2}" dy=".35em" fill="${p.text}" font-size="13.5" font-weight="650">${esc(n.name)}</text>${n.kind === 'view' ? `<text x="${n.width - PAD}" y="${HEADER_H / 2}" dy=".35em" text-anchor="end" fill="${p.muted}" font-size="10" letter-spacing="1">VIEW</text>` : ''}${rows}</g>`
  }).join('')
  const css = `.ln{fill:none;stroke:${p.line};stroke-width:1.3;opacity:.55;transition:opacity .12s,stroke .12s}.cf{stroke-linecap:round}.hit{fill:none;stroke:transparent;stroke-width:10}.card{transition:stroke .12s}.dim .node{opacity:.35}.dim .edge{opacity:.12}.dim .node.on,.dim .edge.on{opacity:1}.edge.on .ln{stroke:${p.accent};opacity:1}.node.on .card{stroke:${p.accent}}`
  const attrs = o.standalone ? ` xmlns="http://www.w3.org/2000/svg" width="${l.width}" height="${l.height}"` : ''
  return `<svg viewBox="0 0 ${Math.max(l.width, 1)} ${Math.max(l.height, 1)}"${attrs} font-family="${p.font}"><style>${css}</style>${o.standalone && o.background !== false ? `<rect width="100%" height="100%" fill="${p.bg}"/>` : ''}<g class="edges">${edges}</g><g class="nodes">${nodes}</g></svg>`
}
