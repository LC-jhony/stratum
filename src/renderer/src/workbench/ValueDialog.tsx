import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../ui/Icon'

/** Pretty-print JSON payloads (drivers hand JSON over as text); everything else shows verbatim. */
function format(v: unknown): string {
  const text = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text }
}

/** Read-only cell viewer (DataGrip's value editor): the full value, pretty JSON, Escape closes. */
export function ValueDialog({ title, value, onClose }: { title: string; value: unknown; onClose(): void }) {
  const [copied, setCopied] = useState(false)
  const text = useMemo(() => format(value), [value])
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('keydown', h)
    return () => removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="dialog value-dialog" aria-label="Cell value" onMouseDown={(e) => e.stopPropagation()}>
        <header><Icon id="symbol-field" /> <span className="value-title">{title}</span><button title="Close (Esc)" onClick={onClose}><Icon id="close" /></button></header>
        <pre className="value-view">{text || '<null>'}</pre>
        <footer>
          <button onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) }}><Icon id="copy" /> {copied ? 'Copied' : 'Copy'}</button>
          <span className="grow" />
          <button className="primary" onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>
  )
}
