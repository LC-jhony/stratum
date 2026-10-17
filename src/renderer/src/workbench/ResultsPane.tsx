import type { DialectId } from '../../../shared/types'
import type { ResultEntry } from '../store/workbench'
import { DataGrid } from './DataGrid'
import { ExportMenu } from './ExportMenu'
import { Icon } from './Icon'

export function ResultsPane({ results, active, onActive, running, dialect }: { results: ResultEntry[]; active: number; onActive(i: number): void; running: boolean; dialect: DialectId }) {
  const cur = results[active]
  if (!cur) return <div className="results empty-state">{running ? <><Icon id="loading" className="codicon-modifier-spin" /> Executing…</> : 'Run a statement with Ctrl/⌘+Enter'}</div>
  const r = cur.result
  return (
    <div className="results">
      <div className="result-tabs">
        {results.map((x, i) => (
          <button key={x.id} className={`${i === active ? 'active' : ''} ${x.result.error ? 'err' : ''}`} onClick={() => onActive(i)}>
            <Icon id={x.result.error ? 'error' : x.result.columns.length ? 'table' : 'check'} />{x.title}
          </button>
        ))}
        <span className="grow" />
        {r.columns.length > 0 && r.rows.length > 0 && <ExportMenu columns={r.columns} rows={r.rows} dialect={dialect} />}
        <span className="result-meta">{r.error ? 'failed' : r.columns.length ? `${r.rows.length}${r.hasMore ? '+' : ''} rows` : `${r.affectedRows ?? 0} rows affected`} · {r.durationMs} ms</span>
      </div>
      {r.error ? <pre className="error-box">{r.error}</pre>
        : r.columns.length ? <DataGrid columns={r.columns} rows={r.rows} />
        : <div className="empty-state"><Icon id="pass" /> {r.affectedRows ?? 0} row(s) affected</div>}
    </div>
  )
}
