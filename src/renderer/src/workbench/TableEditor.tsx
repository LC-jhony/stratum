import { useCallback, useEffect, useMemo, useState } from 'react'
import { ipc } from '../ipc/client'
import { isSqlKind } from '../../../core/kinds'
import { qualify, quote } from '../../../core/quoting'
import { buildDelete, buildInsert, buildUpdate } from '../../../core/sqlgen'
import type { QueryResult } from '../../../shared/types'
import { useWorkbench, type TableTab } from '../store/workbench'
import { DataGrid } from './DataGrid'
import { ExportMenu } from './ExportMenu'
import { Icon } from '../ui/Icon'

const PAGE = 500

/** DataGrip's table editor: filter/order bar, paging, inline edits, add/delete row, Submit/Revert. */
export function TableEditor({ tab, visible }: { tab: TableTab; visible: boolean }) {
  const model = useWorkbench((s) => s.live[tab.connectionId]?.model)
  const conn = useWorkbench((s) => s.connections.find((c) => c.id === tab.connectionId))
  const dialect = model?.dialect ?? 'generic'
  const sqlKind = isSqlKind(conn?.kind)
  const info = model?.schemas.find((s) => (tab.schema ? s.name === tab.schema : true))?.tables.find((t) => t.name === tab.table)
  const pkCols = info?.columns.filter((c) => c.isPrimaryKey).map((c) => c.name) ?? []
  const editable = sqlKind && info?.kind === 'table' && pkCols.length > 0
  const target = qualify(dialect, tab.schema, tab.table)
  /** Non-SQL sources browse through their own statement language; the session pages it like SQL. */
  const redis = conn?.kind === 'redis'
  const elastic = conn?.kind === 'elastic'
  const cassandra = conn?.kind === 'cassandra'
  const s3 = conn?.kind === 's3'
  const ftp = conn?.kind === 'ftp'
  const kafka = conn?.kind === 'kafka'
  const rabbitmq = conn?.kind === 'rabbitmq'
  const source = redis
    ? `INSPECT ${JSON.stringify(tab.table)}`
    : elastic
      ? `SEARCH ${JSON.stringify(tab.table)}`
      : cassandra
        ? `SELECT * FROM ${target}`
        : s3
          ? `LIST ${JSON.stringify(tab.schema ?? tab.table)}`
          : ftp
            ? `LIST ${JSON.stringify(tab.table === '(root)' ? '/' : `/${tab.table}`)}`
            : kafka
              ? `CONSUME ${JSON.stringify(tab.table)}`
              : rabbitmq
                ? `PEEK ${JSON.stringify(tab.schema ?? '/')} ${JSON.stringify(tab.table)}`
                : `db${tab.schema ? `.getSiblingDB(${JSON.stringify(tab.schema)})` : ''}.getCollection(${JSON.stringify(tab.table)}).find({})`

  const [where, setWhere] = useState(''), [order, setOrder] = useState(''), [offset, setOffset] = useState(0)
  const [res, setRes] = useState<QueryResult>(), [busy, setBusy] = useState(false), [msg, setMsg] = useState<string>()
  const [edits, setEdits] = useState(new Map<string, unknown>()), [deleted, setDeleted] = useState(new Set<number>()), [inserted, setInserted] = useState<unknown[][]>([])
  const [selRow, setSelRow] = useState<number>()

  const load = useCallback(async (off = offset) => {
    setBusy(true); setMsg(undefined)
    const q = sqlKind
      ? `select * from ${target}${where.trim() ? ` where ${where}` : ''}${order.trim() ? ` order by ${order}` : ''}`
      : source
    const r = await ipc.db.execute(tab.connectionId, q, { limit: PAGE, offset: off })
    setRes(r); setOffset(off); setBusy(false)
    if (r.error) setMsg(r.error)
    setEdits(new Map()); setDeleted(new Set()); setInserted([])
  }, [tab.connectionId, sqlKind, target, source, where, order, offset])
  useEffect(() => { if (model && !res) void load(0) }, [model])
  useEffect(() => ipc.onCommand((c) => { if (visible && c === 'grid.submit') void submit() }), [visible, edits, deleted, inserted, res])

  const len = res?.rows.length ?? 0
  const pending = edits.size + deleted.size + inserted.length
  const rows = useMemo(() => (res ? [...res.rows, ...inserted] : []), [res, inserted])
  const colIdx = (name: string) => res!.columns.findIndex((c) => c.name === name)

  const onEdit = (r: number, c: number, v: unknown) => {
    if (r >= len) setInserted((p) => p.map((row, i) => (i === r - len ? row.map((x, j) => (j === c ? v : x)) : row)))
    else setEdits((p) => new Map(p).set(`${r}:${c}`, v))
  }
  const addRow = () => { setInserted((p) => [...p, res!.columns.map(() => null)]); setSelRow(len + inserted.length) }
  const delRow = () => {
    if (selRow === undefined) return
    if (selRow >= len) setInserted((p) => p.filter((_, i) => i !== selRow - len))
    else setDeleted((p) => { const n = new Set(p); n.has(selRow) ? n.delete(selRow) : n.add(selRow); return n })
  }

  async function submit() {
    if (!res || !pending) return
    const q = (s: string) => quote(dialect, s), stmts: string[] = []
    const key = (r: number) => ({ columns: pkCols, values: pkCols.map((c) => res.rows[r][colIdx(c)]) })
    const byRow = new Map<number, Record<string, unknown>>()
    for (const [k, v] of edits) { const [r, c] = k.split(':').map(Number); if (deleted.has(r)) continue; byRow.set(r, { ...byRow.get(r), [res.columns[c].name]: v }) }
    for (const [r, ch] of byRow) stmts.push(buildUpdate(q, target, key(r), ch))
    for (const r of deleted) stmts.push(buildDelete(q, target, key(r)))
    for (const row of inserted) stmts.push(buildInsert(q, target, Object.fromEntries(res.columns.map((c, i) => [c.name, row[i]]).filter(([, v]) => v !== null && v !== ''))))
    setBusy(true)
    const out = await ipc.db.submit(tab.connectionId, stmts)
    setBusy(false)
    if (out.ok) { setMsg(`${stmts.length} change(s) submitted`); await load(offset) } else setMsg(out.error)
  }

  return (
    <div className="table-editor">
      <div className="editor-card">
        <div className="editor-toolbar">
          <button title="Reload" onClick={() => void load(offset)}><Icon id="refresh" /></button>
          <button title="Previous page" disabled={!offset} onClick={() => void load(Math.max(0, offset - PAGE))}><Icon id="chevron-left" /></button>
          <span className="page">{res ? `${offset + 1}–${offset + len}` : '…'}</span>
          <button title="Next page" disabled={!res?.hasMore} onClick={() => void load(offset + PAGE)}><Icon id="chevron-right" /></button>
          <span className="sep" />
          <button title="Add row" disabled={!editable} onClick={addRow}><Icon id="add" /></button>
          <button title="Delete row" disabled={!editable || selRow === undefined} onClick={delRow}><Icon id="remove" /></button>
          <button title="Revert" disabled={!pending} onClick={() => void load(offset)}><Icon id="discard" /></button>
          <button className={pending ? 'primary' : ''} title="Submit (Ctrl/⌘+Alt+Enter)" disabled={!pending || busy} onClick={() => void submit()}><Icon id="check" /> Submit{pending ? ` (${pending})` : ''}</button>
          <span className="grow" />
          <ExportMenu columns={res?.columns ?? []} rows={rows} table={tab.table} dialect={dialect} disabled={!res || !!res.error || !rows.length} />
          {!editable && (sqlKind
            ? info && <span className="hint"><Icon id="lock" /> {info.kind === 'view' ? 'View' : 'No primary key'} — read-only</span>
            : <span className="hint"><Icon id="lock" /> {redis ? 'Keys load read-only' : elastic ? 'Indices load read-only' : cassandra ? 'Tables load read-only' : s3 ? 'Objects load read-only' : ftp ? 'Files load read-only' : kafka ? 'Messages load read-only' : rabbitmq ? 'Messages load read-only' : 'Documents load read-only'}</span>)}
        </div>
        {sqlKind && (
          <div className="filters">
            <label><span>WHERE</span><input value={where} placeholder="e.g. id > 10" onChange={(e) => setWhere(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void load(0)} /></label>
            <label><span>ORDER BY</span><input value={order} placeholder="e.g. created_at desc" onChange={(e) => setOrder(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void load(0)} /></label>
          </div>
        )}
        {msg && <div className={`banner ${res?.error || /fail|error|constraint/i.test(msg) ? 'error' : ''}`}>{msg}</div>}
        {res && !res.error ? <DataGrid columns={res.columns} rows={rows} edits={edits} deleted={deleted} insertedFrom={len} readOnlyColumns={editable ? undefined : new Set(res.columns.map((_, i) => i))} onEdit={editable ? onEdit : undefined} onSelectRow={setSelRow} /> : <div className="empty-state">{busy ? 'Loading…' : ''}</div>}
        <div className="grid-foot">{res && !res.error ? `${len} rows${res.hasMore ? '+' : ''} · ${res.durationMs} ms` : ''}</div>
      </div>
    </div>
  )
}
