import { useEffect, useMemo, useRef, useState } from 'react'
import { buildErdGraph, cssPalette, layoutErd, renderErdSvg, resolvePalette, type ErdLayout } from '../erd/erd'
import { useWorkbench, type DiagramTab } from '../store/workbench'
import { Icon } from './Icon'

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

export function ErdView({ tab, visible }: { tab: DiagramTab; visible: boolean }) {
  const model = useWorkbench((s) => s.live[tab.connectionId]?.model)
  const openTable = useWorkbench((s) => s.openTable)
  const [layout, setLayout] = useState<ErdLayout>()
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const [showTypes, setShowTypes] = useState(true), [views, setViews] = useState(!!tab.options.includeViews)
  const box = useRef<HTMLDivElement>(null), svgHost = useRef<HTMLDivElement>(null)

  useEffect(() => { void useWorkbench.getState().connect(tab.connectionId) }, [])
  useEffect(() => {
    if (!model) return
    let live = true
    void layoutErd(buildErdGraph(model, { ...tab.options, includeViews: views })).then((l) => { if (live) { setLayout(l); requestAnimationFrame(() => fit(l)) } })
    return () => { live = false }
  }, [model, views, tab.options])
  // Palette is CSS vars, so a theme switch only needs the stylesheet to change — no re-layout.
  const svg = useMemo(() => (layout ? renderErdSvg(layout, cssPalette(), { showTypes }) : ''), [layout, showTypes])

  function fit(l = layout) {
    const el = box.current; if (!l || !el || !l.width) return
    const k = clamp(Math.min(el.clientWidth / l.width, el.clientHeight / l.height) * 0.96, 0.15, 1.2)
    setView({ k, x: (el.clientWidth - l.width * k) / 2, y: (el.clientHeight - l.height * k) / 2 })
  }
  useEffect(() => { if (visible) fit() }, [visible])

  // Figma convention: wheel/two-finger scroll pans; Ctrl/⌘+wheel and trackpad pinch (which sends ctrlKey) zoom at the cursor.
  const onWheel = (e: React.WheelEvent) => {
    const r = box.current!.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top
    if (e.ctrlKey || e.metaKey) setView((v) => { const k = clamp(v.k * Math.exp(-e.deltaY * 0.0025), 0.1, 3); return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k } })
    else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
  }
  const drag = (e: React.MouseEvent) => {
    if ((e.target as Element).closest('.node') && e.detail > 1) return
    const x0 = e.clientX, y0 = e.clientY, v0 = view
    const mm = (m: MouseEvent) => setView({ ...v0, x: v0.x + m.clientX - x0, y: v0.y + m.clientY - y0 })
    const up = () => { removeEventListener('mousemove', mm); removeEventListener('mouseup', up) }
    addEventListener('mousemove', mm); addEventListener('mouseup', up)
  }
  const hover = (e: React.MouseEvent) => {
    const root = svgHost.current?.querySelector('svg'); if (!root || !layout) return
    const id = (e.target as Element).closest<SVGGElement>('.node')?.dataset.id
    root.classList.toggle('dim', !!id)
    const rel = new Set(id ? [id] : [])
    layout.edges.forEach((ed) => { if (id && (ed.from === id || ed.to === id)) { rel.add(ed.from); rel.add(ed.to) } })
    root.querySelectorAll<SVGGElement>('.node').forEach((n) => n.classList.toggle('on', !!id && rel.has(n.dataset.id!)))
    root.querySelectorAll<SVGGElement>('.edge').forEach((n) => n.classList.toggle('on', !!id && (n.dataset.from === id || n.dataset.to === id)))
  }
  const dbl = (e: React.MouseEvent) => {
    const id = (e.target as Element).closest<SVGGElement>('.node')?.dataset.id; if (!id) return
    const n = layout?.nodes.find((x) => x.id === id); if (n) openTable(tab.connectionId, n.name, n.schema)
  }
  const download = (name: string, href: string) => { const a = document.createElement('a'); a.href = href; a.download = name; a.click() }
  const standalone = () => renderErdSvg(layout!, resolvePalette(cssPalette(), getComputedStyle(document.documentElement)), { showTypes, standalone: true })
  const exportSvg = () => download(`${tab.title}.svg`, URL.createObjectURL(new Blob([standalone()], { type: 'image/svg+xml' })))
  const exportPng = () => {
    const img = new Image(), s = 2
    img.onload = () => { const c = document.createElement('canvas'); c.width = layout!.width * s; c.height = layout!.height * s; const g = c.getContext('2d')!; g.scale(s, s); g.drawImage(img, 0, 0); download(`${tab.title}.png`, c.toDataURL('image/png')) }
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(standalone())
  }

  return (
    <div className="erd">
      <div className="editor-toolbar">
        <button title="Fit to window" onClick={() => fit()}><Icon id="screen-full" /></button>
        <button title="Zoom in" onClick={() => setView((v) => ({ ...v, k: clamp(v.k * 1.2, 0.1, 3) }))}><Icon id="zoom-in" /></button>
        <button title="Zoom out" onClick={() => setView((v) => ({ ...v, k: clamp(v.k / 1.2, 0.1, 3) }))}><Icon id="zoom-out" /></button>
        <span className="sep" />
        <button className={showTypes ? 'toggled' : ''} title="Show column types" onClick={() => setShowTypes(!showTypes)}><Icon id="symbol-key" /> Types</button>
        <button className={views ? 'toggled' : ''} title="Include views" onClick={() => setViews(!views)}><Icon id="eye" /> Views</button>
        <span className="grow" />
        <span className="hint">{layout ? `${layout.nodes.length} tables · ${layout.edges.length} relations` : ''}</span>
        <button title="Export SVG" disabled={!layout} onClick={exportSvg}><Icon id="file-media" /> SVG</button>
        <button title="Export PNG" disabled={!layout} onClick={exportPng}><Icon id="file-media" /> PNG</button>
      </div>
      <div className="erd-canvas" ref={box} onWheel={onWheel} onMouseDown={drag} onMouseOver={hover} onMouseLeave={hover} onDoubleClick={dbl}>
        {!model && <div className="empty-state">Connecting…</div>}
        {model && layout && !layout.nodes.length && <div className="empty-state">No tables to show.</div>}
        <div ref={svgHost} className="erd-svg" style={{ width: layout?.width, height: layout?.height, transform: `translate(${view.x}px,${view.y}px) scale(${view.k})` }} dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    </div>
  )
}
