import { useEffect, useMemo, useRef, useState } from 'react'
import { ipc } from '../ipc/client'
import { buildErdGraph, cssPalette, exportPalette, layoutErd, renderErdSvg, resolvePalette, type ErdLayout, type ErdNode } from '../erd/erd'
import { useWorkbench, type DiagramTab } from '../store/workbench'
import { Icon } from '../ui/Icon'

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
/** Raster exports above this many pixels per side trip canvas limits; the PNG scale is lowered to fit. */
const MAX_PX = 16384

const blobBase64 = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(r.error); r.readAsDataURL(b) })

export function ErdView({ tab, visible }: { tab: DiagramTab; visible: boolean }) {
  const model = useWorkbench((s) => s.live[tab.connectionId]?.model)
  const loading = useWorkbench((s) => !!s.live[tab.connectionId]?.loadingModel)
  const openTable = useWorkbench((s) => s.openTable)
  const openDiagram = useWorkbench((s) => s.openDiagram)
  const [layout, setLayout] = useState<ErdLayout>()
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const [showTypes, setShowTypes] = useState(true), [views, setViews] = useState(!!tab.options.includeViews)
  const [query, setQuery] = useState(''), [match, setMatch] = useState(0)
  const [selected, setSelected] = useState<string>()
  const [menu, setMenu] = useState<{ x: number; y: number; node: ErdNode }>()
  const [exportOpen, setExportOpen] = useState(false), [transparent, setTransparent] = useState(false), [busy, setBusy] = useState<string>()
  const [msg, setMsg] = useState<string>()
  const box = useRef<HTMLDivElement>(null), svgHost = useRef<HTMLDivElement>(null)
  const manual = useRef(false) // set by pan/zoom, cleared by Fit: while false, resizes keep the diagram fitted
  const moved = useRef(false) // a pan happened, so the trailing click must not clear the selection

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
  // Tab switches keep the user's view; the canvas just takes focus so the keyboard shortcuts work.
  useEffect(() => { if (visible) box.current?.focus({ preventScroll: true }) }, [visible])
  // Window and side-bar resizes keep the diagram centred until the user pans or zooms by hand.
  useEffect(() => {
    const el = box.current; if (!el) return
    const ro = new ResizeObserver(() => { if (!manual.current && el.clientWidth > 0) fit() })
    ro.observe(el)
    return () => ro.disconnect()
  }, [layout])

  // Search hits win over the pinned selection; hover previews only when neither is set.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q && layout ? layout.nodes.filter((n) => `${n.schema}.${n.name}`.toLowerCase().includes(q)) : []
  }, [query, layout])
  useEffect(() => {
    const root = svgHost.current?.querySelector('svg'); if (!root || !layout) return
    const hits = query.trim() ? new Set(matches.map((n) => n.id))
      : selected ? new Set([selected, ...layout.edges.flatMap((e) => (e.from === selected ? [e.to] : e.to === selected ? [e.from] : []))])
        : undefined
    root.classList.toggle('dim', !!hits)
    root.querySelectorAll<SVGGElement>('.node').forEach((n) => n.classList.toggle('on', !!hits?.has(n.dataset.id!)))
    root.querySelectorAll<SVGGElement>('.edge').forEach((n) => n.classList.toggle('on', !!hits && (hits.has(n.dataset.from!) || hits.has(n.dataset.to!))))
  }, [query, matches, selected, layout, svg])
  useEffect(() => setMatch((i) => (matches.length ? Math.min(i, matches.length - 1) : 0)), [matches.length])

  // Figma convention: wheel/two-finger scroll pans; Ctrl/⌘+wheel and trackpad pinch (which sends ctrlKey) zoom at the cursor.
  const onWheel = (e: React.WheelEvent) => {
    manual.current = true
    const r = box.current!.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top
    if (e.ctrlKey || e.metaKey) setView((v) => { const k = clamp(v.k * Math.exp(-e.deltaY * 0.0025), 0.1, 3); return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k } })
    else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
  }
  /** Toolbar zoom anchors at the viewport centre, unlike the wheel which anchors at the cursor. */
  const zoomAt = (factor: number) => {
    manual.current = true
    setView((v) => {
      const el = box.current, k = clamp(v.k * factor, 0.1, 3)
      if (!el) return { ...v, k }
      const px = el.clientWidth / 2, py = el.clientHeight / 2
      return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k }
    })
  }
  const resetZoom = () => zoomAt(1 / view.k)

  const nodeAt = (e: React.MouseEvent) => (e.target as Element).closest<SVGGElement>('.node')?.dataset.id
  const drag = (e: React.MouseEvent) => {
    moved.current = false
    setMenu(undefined)
    if ((e.target as Element).closest('.node') && e.detail > 1) return
    const x0 = e.clientX, y0 = e.clientY, v0 = view
    const mm = (m: MouseEvent) => {
      if (Math.abs(m.clientX - x0) + Math.abs(m.clientY - y0) > 4) { moved.current = true; manual.current = true }
      setView({ ...v0, x: v0.x + m.clientX - x0, y: v0.y + m.clientY - y0 })
    }
    const up = () => { removeEventListener('mousemove', mm); removeEventListener('mouseup', up) }
    addEventListener('mousemove', mm); addEventListener('mouseup', up)
  }
  const click = (e: React.MouseEvent) => {
    setMenu(undefined)
    if (moved.current) { moved.current = false; return }
    setSelected(nodeAt(e))
  }
  const hover = (e: React.MouseEvent) => {
    if (query.trim() || selected) return
    const root = svgHost.current?.querySelector('svg'); if (!root || !layout) return
    const id = nodeAt(e)
    root.classList.toggle('dim', !!id)
    const rel = new Set(id ? [id] : [])
    layout.edges.forEach((ed) => { if (id && (ed.from === id || ed.to === id)) { rel.add(ed.from); rel.add(ed.to) } })
    root.querySelectorAll<SVGGElement>('.node').forEach((n) => n.classList.toggle('on', !!id && rel.has(n.dataset.id!)))
    root.querySelectorAll<SVGGElement>('.edge').forEach((n) => n.classList.toggle('on', !!id && (n.dataset.from === id || n.dataset.to === id)))
  }
  const dbl = (e: React.MouseEvent) => {
    const id = nodeAt(e); if (!id) return
    const n = layout?.nodes.find((x) => x.id === id); if (n) openTable(tab.connectionId, n.name, n.schema)
  }
  const context = (e: React.MouseEvent) => {
    const id = nodeAt(e); if (!id) return
    const n = layout?.nodes.find((x) => x.id === id); if (!n) return
    e.preventDefault()
    const r = box.current!.getBoundingClientRect()
    setSelected(id)
    setMenu({ x: clamp(e.clientX - r.left, 0, Math.max(0, r.width - 200)), y: clamp(e.clientY - r.top, 0, Math.max(0, r.height - 112)), node: n })
  }
  /** Enter in the finder cycles matches and brings the next one to the centre of the viewport. */
  const goto = (delta: number) => {
    if (!matches.length) return
    const i = (match + delta + matches.length) % matches.length, n = matches[i], el = box.current
    setMatch(i)
    if (el) { manual.current = true; setView((v) => ({ k: v.k, x: el.clientWidth / 2 - (n.x + n.width / 2) * v.k, y: el.clientHeight / 2 - (n.y + n.height / 2) * v.k })) }
  }
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setSelected(undefined); setQuery(''); setMenu(undefined); setExportOpen(false) }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(1.2) }
    else if (e.key === '-') { e.preventDefault(); zoomAt(1 / 1.2) }
    else if (e.key === '0') { e.preventDefault(); manual.current = false; fit() }
  }
  const searchKeys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); goto(e.shiftKey ? -1 : 1) }
    else if (e.key === 'Escape') { setQuery(''); (e.target as HTMLInputElement).blur() }
  }

  // Exports always render the full diagram standalone in the fixed light palette: files keep a white background whatever the active theme. Only the configured fonts are carried over.
  const standalone = (background: boolean) => {
    const live = resolvePalette(cssPalette(), getComputedStyle(document.documentElement))
    return renderErdSvg(layout!, exportPalette({ font: live.font, mono: live.mono }), { showTypes, standalone: true, background })
  }
  const fileBase = () => tab.title.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'diagram'
  const runExport = async (label: string, fn: () => Promise<string | null>) => {
    setBusy(label); setMsg(undefined)
    try { const p = await fn(); setMsg(p ? `Saved to ${p}` : undefined) }
    catch (e) { setMsg(`Export failed: ${e instanceof Error ? e.message : String(e)}`) }
    finally { setBusy(undefined) }
  }
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(undefined), 6000); return () => clearTimeout(t) }, [msg])
  const saveSvg = () => ipc.export.save(`${fileBase()}.svg`, standalone(!transparent), [{ name: 'SVG image', extensions: ['svg'] }])
  const savePng = async (scale: number) => {
    if (!layout) return null
    const s = Math.min(scale, MAX_PX / layout.width, MAX_PX / layout.height)
    const blob = await new Promise<Blob | null>((res) => {
      const img = new Image()
      img.onload = () => {
        const c = document.createElement('canvas')
        c.width = Math.max(1, Math.round(layout.width * s)); c.height = Math.max(1, Math.round(layout.height * s))
        const g = c.getContext('2d')!; g.scale(s, s); g.drawImage(img, 0, 0); c.toBlob(res, 'image/png')
      }
      img.onerror = () => res(null)
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(standalone(!transparent))
    })
    if (!blob) throw new Error('image rendering failed')
    return ipc.export.saveBinary(`${fileBase()}.png`, await blobBase64(blob), [{ name: 'PNG image', extensions: ['png'] }])
  }
  const savePdf = () => (layout ? ipc.export.pdf(`${fileBase()}.pdf`, standalone(true), { width: layout.width, height: layout.height }) : Promise.resolve(null))

  return (
    <div className="erd">
      <div className="editor-card">
        <div className="editor-toolbar">
          <button title="Fit to window (0)" onClick={() => { manual.current = false; fit() }}><Icon id="screen-full" /></button>
          <button title="Zoom out (−)" onClick={() => zoomAt(1 / 1.2)}><Icon id="zoom-out" /></button>
          <button className="zoom-pct" title="Reset zoom to 100%" onClick={resetZoom}>{Math.round(view.k * 100)}%</button>
          <button title="Zoom in (+)" onClick={() => zoomAt(1.2)}><Icon id="zoom-in" /></button>
          <span className="sep" />
          <span className="erd-search">
            <input value={query} placeholder="Find table…" spellCheck={false} onChange={(e) => { setQuery(e.target.value); setMatch(0) }} onKeyDown={searchKeys} />
            {query.trim() && <span className="erd-search-count">{matches.length ? `${match + 1}/${matches.length}` : '0/0'}</span>}
          </span>
          <span className="sep" />
          <button className={showTypes ? 'toggled' : ''} title="Show column types" onClick={() => setShowTypes(!showTypes)}><Icon id="symbol-key" /> Types</button>
          <button className={views ? 'toggled' : ''} title="Include views" onClick={() => setViews(!views)}><Icon id="eye" /> Views</button>
          <button title="Refresh schema" disabled={loading} onClick={() => void useWorkbench.getState().refresh(tab.connectionId)}><Icon id="refresh" /></button>
          <span className="grow" />
          <span className="hint">{layout ? `${layout.nodes.length} tables · ${layout.edges.length} relations` : ''}</span>
          <span className="menu-host">
            <button title="Export diagram" disabled={!layout || !!busy} onClick={() => setExportOpen((o) => !o)}><Icon id="cloud-download" /> Export</button>
            {exportOpen && (
              <div className="popmenu" onMouseLeave={() => setExportOpen(false)}>
                <button className={transparent ? 'toggled' : ''} title="Omit the white background from SVG and PNG" onClick={() => setTransparent(!transparent)}>{transparent && <Icon id="check" />} Transparent background</button>
                <button onClick={() => { setExportOpen(false); void runExport('SVG', saveSvg) }}>SVG</button>
                <button onClick={() => { setExportOpen(false); void runExport('PNG 1×', () => savePng(1)) }}>PNG 1×</button>
                <button onClick={() => { setExportOpen(false); void runExport('PNG 2×', () => savePng(2)) }}>PNG 2×</button>
                <button onClick={() => { setExportOpen(false); void runExport('PNG 4×', () => savePng(4)) }}>PNG 4×</button>
                <button onClick={() => { setExportOpen(false); void runExport('PDF', savePdf) }}>PDF (vector)</button>
              </div>
            )}
          </span>
          {busy && <span className="result-meta exporting" role="status"><span className="spinner" aria-hidden="true" /> Exporting {busy}…</span>}
          {msg && <span className="result-meta" title={msg}><Icon id="pass" /> {msg.split(/[\\/]/).pop()}</span>}
        </div>
        <div className="erd-canvas" ref={box} tabIndex={0} onWheel={onWheel} onMouseDown={drag} onMouseOver={hover} onMouseLeave={hover} onDoubleClick={dbl} onClick={click} onContextMenu={context} onKeyDown={key}>
          {!model && <div className="empty-state">Connecting…</div>}
          {model && layout && !layout.nodes.length && <div className="empty-state">No tables to show.</div>}
          <div ref={svgHost} className="erd-svg" style={{ width: layout?.width, height: layout?.height, transform: `translate(${view.x}px,${view.y}px) scale(${view.k})` }} dangerouslySetInnerHTML={{ __html: svg }} />
          {menu && (
            <div className="popmenu erd-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
              <button onClick={() => { setMenu(undefined); openTable(tab.connectionId, menu.node.name, menu.node.schema) }}><Icon id="go-to-file" /> Open table</button>
              <button onClick={() => { setMenu(undefined); void navigator.clipboard.writeText(`${menu.node.schema}.${menu.node.name}`) }}><Icon id="copy" /> Copy name</button>
              <button onClick={() => { setMenu(undefined); openDiagram(tab.connectionId, { schemas: [menu.node.schema], focus: { table: menu.node.name, depth: 1 } }) }}><Icon id="type-hierarchy" /> Show diagram (neighbours)</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
