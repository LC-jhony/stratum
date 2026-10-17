import { useState } from 'react'
import { EXPORT_FORMATS, exportText, type ExportFormat } from '../../../shared/export'
import type { ColumnMeta, DialectId } from '../../../shared/types'
import { Icon } from './Icon'

/** Export the visible grid (DataGrip CSV formats + JSON and SQL INSERTs) through a save dialog. */
export function ExportMenu({ columns, rows, table, dialect, disabled }: { columns: ColumnMeta[]; rows: unknown[][]; table?: string; dialect: DialectId; disabled?: boolean }) {
  const [open, setOpen] = useState(false), [msg, setMsg] = useState<string>()
  const run = async (format: ExportFormat) => {
    setOpen(false)
    const spec = EXPORT_FORMATS.find((f) => f.id === format)!
    const path = await window.stratum.export.save(`${table ?? 'result'}.${spec.ext}`, exportText(columns, rows, format, table ?? 'result', dialect))
    setMsg(path ? `Saved to ${path}` : undefined)
    if (path) setTimeout(() => setMsg(undefined), 5000)
  }
  return (
    <span className="menu-host">
      <button title="Export data" disabled={disabled} onClick={() => setOpen((o) => !o)}><Icon id="cloud-download" /></button>
      {open && (
        <div className="popmenu" onMouseLeave={() => setOpen(false)}>
          {EXPORT_FORMATS.map((f) => <button key={f.id} onClick={() => void run(f.id)}>{f.label}</button>)}
        </div>
      )}
      {msg && <span className="result-meta" title={msg}><Icon id="pass" /> {msg.split('/').pop()}</span>}
    </span>
  )
}
