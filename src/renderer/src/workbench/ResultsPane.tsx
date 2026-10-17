import { useEffect, useMemo, useState } from 'react'
import type { DialectId } from '../../../shared/types'
import { filterRows, sortRows, type GridSort } from '../../../shared/gridView'
import { useWorkbench, type ResultEntry } from '../store/workbench'
import { DataGrid } from './DataGrid'
import { ExportMenu } from './ExportMenu'
import { Icon } from './Icon'
import { ValueDialog } from './ValueDialog'

export function ResultsPane({ tabId, results, active, onActive, running, dialect }: { tabId: string; results: ResultEntry[]; active: number; onActive(i: number): void; running: boolean; dialect: DialectId }) {
  const fetchMore = useWorkbench((s) => s.fetchMore), fetchAll = useWorkbench((s) => s.fetchAll)
  const pageSize = useWorkbench((s) => s.prefs['query.pageSize'])
  const [filter, setFilter] = useState(''), [sort, setSort] = useState<GridSort | null>(null)
  const [viewer, setViewer] = useState<{ title: string; value: unknown } | null>(null)
  const cur = results[active]
  useEffect(() => { setFilter(''); setSort(null); setViewer(null) }, [cur?.id]) // a new result starts unsorted and unfiltered
  const rows = cur?.result.rows ?? []
  const view = useMemo(() => sortRows(filterRows(rows, filter), sort), [rows, filter, sort])
  if (!cur) return <div className="results empty-state">{running ? <><Icon id="loading" className="codicon-modifier-spin" /> Executing…</> : 'Run a statement with Ctrl/⌘+Enter'}</div>
  const r = cur.result
  const grid = !r.error && r.columns.length > 0
  const cycleSort = (col: number) => setSort((s) => (s?.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null))
  return (
    <div className="results">
      <div className="result-tabs">
        {results.map((x, i) => (
          <button key={x.id} className={`${i === active ? 'active' : ''} ${x.result.error ? 'err' : ''}`} onClick={() => onActive(i)}>
            <Icon id={x.result.error ? 'error' : x.result.columns.length ? 'table' : 'check'} />{x.title}
          </button>
        ))}
        <span className="grow" />
        {grid && view.length > 0 && <ExportMenu columns={r.columns} rows={view} dialect={dialect} />}
        <span className="result-meta">{r.error ? 'failed' : r.columns.length ? `${rows.length}${r.hasMore ? '+' : ''} rows` : `${r.affectedRows ?? 0} rows affected`} · {r.durationMs} ms</span>
      </div>
      {grid && (
        <div className="filters grid-filter">
          <label>
            <Icon id="search" />
            <input value={filter} placeholder="Filter rows…" spellCheck={false} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setFilter('') }} />
          </label>
          {filter !== '' && <span className="result-meta">{view.length} of {rows.length}{r.hasMore ? '+' : ''}</span>}
          {sort && <span className="result-meta" title="Click the column header to change the sort">sorted by {r.columns[sort.col]?.name} {sort.dir === 1 ? '↑' : '↓'}</span>}
        </div>
      )}
      {r.error ? <pre className="error-box">{r.error}</pre>
        : r.columns.length ? <DataGrid columns={r.columns} rows={view} sort={sort} onSort={cycleSort} onOpenValue={(row, col) => setViewer({ title: `${r.columns[col].name}${r.columns[col].type ? ` · ${r.columns[col].type}` : ''}`, value: view[row]?.[col] })} />
        : <div className="empty-state"><Icon id="pass" /> {r.affectedRows ?? 0} row(s) affected</div>}
      {grid && (r.hasMore || cur.fetchError) && (
        <div className="grid-foot grid-foot-more">
          {cur.fetchError && <span className="fetch-error" title={cur.fetchError}><Icon id="error" /> {cur.fetchError}</span>}
          <span className="grow" />
          {r.hasMore && <>
            <button disabled={running} title={`Fetch the next ${pageSize} rows`} onClick={() => void fetchMore(tabId, active)}><Icon id="chevron-down" /> Fetch next {pageSize}</button>
            <button disabled={running} title="Fetch every remaining page (capped at 50 pages per click)" onClick={() => void fetchAll(tabId, active)}><Icon id="run-all" /> Fetch all</button>
          </>}
          {running && <Icon id="loading" className="codicon-modifier-spin" />}
        </div>
      )}
      {viewer && <ValueDialog title={viewer.title} value={viewer.value} onClose={() => setViewer(null)} />}
    </div>
  )
}
