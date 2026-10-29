import { useState } from 'react'
import { ipc } from '../ipc/client'
import { createPortal } from 'react-dom'
import { EXPORT_FORMATS, exportText, type ExportId } from '../../../core/export'
import { EXPORT_BLOCK, collectRows } from '../../../core/exportBudget'
import { bytesToBase64, exportXlsx } from '../../../core/xlsx'
import type { ColumnMeta, DialectId } from '../../../shared/types'
import { Icon } from './Icon'

/** The query behind the grid, so "All rows" can fetch the rest instead of exporting one page. */
export interface ExportSource {
  connectionId: string
  sql: string
  /** Server offset of the first element of `rawRows`. */
  offset: number
  /** Unfiltered rows already loaded; contiguous from `offset`. */
  rawRows: unknown[][]
  /** Whether the server reported more rows after `rawRows`. */
  hasMore: boolean
}

/** Export the grid (or every row behind it) through a native save dialog. */
export function ExportMenu({ columns, rows, source, table, dialect, disabled, neutralizeFormulas = true }: {
  columns: ColumnMeta[]
  /** Rows currently visible in the grid (filtered and sorted as shown). */
  rows: unknown[][]
  source?: ExportSource
  table?: string
  dialect: DialectId
  disabled?: boolean
  /** Prefix text a spreadsheet would execute as a formula (delimiter-separated formats only). */
  neutralizeFormulas?: boolean
}) {
  const [open, setOpen] = useState(false), [scope, setScope] = useState<'loaded' | 'all'>('loaded')
  const [msg, setMsg] = useState<{ text: string; error?: boolean }>()
  const [busy, setBusy] = useState(false)
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number }>()

  const allRows = async (): Promise<unknown[][]> => {
    if (!source) return rows
    setMsg({ text: `Fetching rows… ${source.rawRows.length.toLocaleString('en-US')} loaded` })
    return collectRows({
      head: source.rawRows,
      offset: source.offset,
      hasMore: source.hasMore,
      fetchPage: async (offset, limit) => {
        const page = await ipc.db.execute(source.connectionId, source.sql, { limit, offset, full: true })
        return { rows: page.rows, hasMore: page.hasMore, error: page.error }
      },
      onProgress: (loaded) => setMsg({ text: `Fetching rows… ${loaded.toLocaleString('en-US')} loaded` }),
    })
  }

  const run = async (format: ExportId) => {
    setOpen(false)
    const spec = EXPORT_FORMATS.find((f) => f.id === format)!
    setBusy(true)
    try {
      const data = scope === 'all' ? await allRows() : rows
      const name = `${table ?? 'result'}.${spec.ext}`
      const filters = [{ name: spec.label, extensions: [spec.ext] }]
      const path = format === 'xlsx'
        ? await ipc.export.saveBinary(name, bytesToBase64(exportXlsx(columns, data, table ?? 'result')), filters)
        : await ipc.export.save(name, exportText(columns, data, format, table ?? 'result', dialect, { neutralizeFormulas }), filters)
      setMsg(path ? { text: `Saved ${data.length.toLocaleString('en-US')} rows to ${path}` } : undefined)
      if (path) setTimeout(() => setMsg(undefined), 5000)
    } catch (e) {
      // Never fail silently: a fetch, a size limit or a disk error must be visible next to the grid.
      const text = e instanceof Error ? e.message : String(e)
      setMsg({ text: text.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), error: true })
    } finally {
      setBusy(false)
    }
  }

  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setPos({ ...(window.innerHeight - r.bottom >= 360 ? { top: r.bottom + 4 } : { bottom: window.innerHeight - r.top + 4 }), right: Math.max(8, window.innerWidth - r.right) })
    setMsg(undefined)
    setOpen((o) => !o)
  }

  // The menu lives in a portal: the results tab strip scrolls (overflow-x: auto), so an in-flow popmenu would be clipped out of view.
  return (
    <span className="menu-host">
      <button title="Export data" disabled={disabled || busy} onClick={toggle}>{busy ? <Icon id="loading" className="codicon-modifier-spin" /> : <Icon id="cloud-download" />}</button>
      {open && pos && createPortal(
        <div className="popmenu popmenu-fixed" style={{ top: pos.top, bottom: pos.bottom, right: pos.right }} onMouseLeave={() => setOpen(false)}>
          <div className="export-scope" role="radiogroup" aria-label="Rows to export">
            <button role="radio" aria-checked={scope === 'loaded'} className={scope === 'loaded' ? 'on' : ''} onClick={() => setScope('loaded')}>Loaded rows <em>{rows.length.toLocaleString('en-US')}</em></button>
            <button role="radio" aria-checked={scope === 'all'} className={scope === 'all' ? 'on' : ''} disabled={!source} title={source ? 'Fetch every row from the server' : 'Only the loaded page is available here'} onClick={() => setScope('all')}>All rows</button>
          </div>
          {scope === 'all' && <span className="export-note">Fetches the remaining rows ({EXPORT_BLOCK.toLocaleString('en-US')} per request). The grid filter and sort are not applied.</span>}
          {EXPORT_FORMATS.map((f) => <button key={f.id} onClick={() => void run(f.id)}>{f.label}</button>)}
        </div>, document.body)}
      {msg && <span className={`result-meta${msg.error ? ' err' : ''}`} title={msg.text}><Icon id={msg.error ? 'error' : 'pass'} /> {msg.error ? msg.text : msg.text.split('/').pop()}</span>}
    </span>
  )
}
