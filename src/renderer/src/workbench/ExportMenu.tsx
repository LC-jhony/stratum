import { useState } from 'react'
import { ipc } from '../ipc/client'
import { createPortal } from 'react-dom'
import { EXPORT_FORMATS, exportText, type ExportId } from '../../../core/export'
import { bytesToBase64, exportXlsx } from '../../../core/xlsx'
import type { ColumnMeta, DialectId } from '../../../shared/types'
import { Icon } from '../ui/Icon'

/** Export the visible grid (DataGrip CSV formats + JSON/SQL INSERTs + an Excel workbook) through a native save dialog. */
export function ExportMenu({ columns, rows, table, dialect, disabled }: { columns: ColumnMeta[]; rows: unknown[][]; table?: string; dialect: DialectId; disabled?: boolean }) {
  const [open, setOpen] = useState(false), [msg, setMsg] = useState<string>()
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number }>()
  const run = async (format: ExportId) => {
    setOpen(false)
    const spec = EXPORT_FORMATS.find((f) => f.id === format)!
    const name = `${table ?? 'result'}.${spec.ext}`
    const filters = [{ name: spec.label, extensions: [spec.ext] }]
    const path = format === 'xlsx'
      ? await ipc.export.saveBinary(name, bytesToBase64(exportXlsx(columns, rows, table ?? 'result')), filters)
      : await ipc.export.save(name, exportText(columns, rows, format, table ?? 'result', dialect), filters)
    setMsg(path ? `Saved to ${path}` : undefined)
    if (path) setTimeout(() => setMsg(undefined), 5000)
  }
  // The menu lives in a portal: the results tab strip scrolls (overflow-x: auto), so an in-flow popmenu would be clipped out of view.
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setPos({ ...(window.innerHeight - r.bottom >= 340 ? { top: r.bottom + 4 } : { bottom: window.innerHeight - r.top + 4 }), right: Math.max(8, window.innerWidth - r.right) })
    setOpen((o) => !o)
  }
  return (
    <span className="menu-host">
      <button title="Export data" disabled={disabled} onClick={toggle}><Icon id="cloud-download" /></button>
      {open && pos && createPortal(
        <div className="popmenu popmenu-fixed" style={{ top: pos.top, bottom: pos.bottom, right: pos.right }} onMouseLeave={() => setOpen(false)}>
          {EXPORT_FORMATS.map((f) => <button key={f.id} onClick={() => void run(f.id)}>{f.label}</button>)}
        </div>, document.body)}
      {msg && <span className="result-meta" title={msg}><Icon id="pass" /> {msg.split('/').pop()}</span>}
    </span>
  )
}
