import { useEffect, useMemo, useState } from 'react'
import { geometrySummary, looksLikeGeometry, parseGeometry, polygonPath, projectGeometry } from '../../../core/gis'
import { Icon } from './Icon'

/** Pretty-print JSON payloads (drivers hand JSON over as text); everything else shows verbatim. */
function format(v: unknown): string {
  const text = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text }
}

/**
 * Read-only cell viewer (DataGrip's value editor): the full value, pretty JSON, a spatial map for
 * WKT/GeoJSON/EWKB values, Escape closes. Geometry detection is local: no network, no map tiles.
 */
export function ValueDialog({ title, value, onClose }: { title: string; value: unknown; onClose(): void }) {
  const [copied, setCopied] = useState(false)
  const text = useMemo(() => format(value), [value])
  const geometry = useMemo(() => (looksLikeGeometry(text) ? parseGeometry(text) : undefined), [text])
  const view = useMemo(() => (geometry ? projectGeometry(geometry) : undefined), [geometry])
  const [tab, setTab] = useState<'text' | 'map'>(geometry ? 'map' : 'text')
  useEffect(() => { setTab(geometry ? 'map' : 'text') }, [geometry])
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('keydown', h)
    return () => removeEventListener('keydown', h)
  }, [onClose])
  const bounds = view?.bounds
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="dialog value-dialog" aria-label="Cell value" onMouseDown={(e) => e.stopPropagation()}>
        <header><Icon id="symbol-field" /> <span className="value-title">{title}</span><button title="Close (Esc)" onClick={onClose}><Icon id="close" /></button></header>
        {geometry && (
          <div className="value-tabs" role="tablist" aria-label="Value view">
            <button type="button" role="tab" aria-selected={tab === 'map'} className={tab === 'map' ? 'on' : ''} onClick={() => setTab('map')}><Icon id="globe" /> Map</button>
            <button type="button" role="tab" aria-selected={tab === 'text'} className={tab === 'text' ? 'on' : ''} onClick={() => setTab('text')}><Icon id="json" /> Text</button>
          </div>
        )}
        {geometry && view && tab === 'map' ? (
          <div className="gis-view">
            <svg viewBox={`0 0 ${view.width} ${view.height}`} role="img" aria-label={`${geometry.type} preview`}>
              {view.shapes.map((shape, i) => shape.kind === 'polygon'
                ? <path key={i} className="gis-poly" d={polygonPath(shape.rings)} fillRule="evenodd" />
                : shape.kind === 'line'
                  ? <polyline key={i} className="gis-line" points={shape.points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')} />
                  : <circle key={i} className="gis-point" cx={shape.x} cy={shape.y} r={3.5} />)}
            </svg>
            <div className="gis-foot">
              <span>{geometrySummary(geometry)}</span>
              {bounds && <span>bbox {bounds.minX.toLocaleString()} {bounds.minY.toLocaleString()} · {bounds.maxX.toLocaleString()} {bounds.maxY.toLocaleString()}</span>}
              <span>Plane coordinates (no reprojection)</span>
            </div>
          </div>
        ) : <pre className="value-view">{text || '<null>'}</pre>}
        <footer>
          <button onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) }}><Icon id="copy" /> {copied ? 'Copied' : 'Copy'}</button>
          <span className="grow" />
          <button className="primary" onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>
  )
}
