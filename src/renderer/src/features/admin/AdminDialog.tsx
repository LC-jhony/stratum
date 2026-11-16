import { useEffect, useMemo, useState } from 'react'
import { connectionDialect } from '../../../../core/dialects'
import { dashboardQueries, formatBytes, metricValue, modelStats } from '../../../../core/dashboard'
import { taskExtension } from '../../../../core/tasks'
import type { ScheduledTask, TaskFormat, TaskInput } from '../../../../shared/tasks'
import { ipc } from '../../ipc/client'
import { useWorkbench } from '../../store/workbench'
import { Icon } from '../../ui/Icon'

const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
const when = (ms: number | undefined) => (ms ? new Date(ms).toLocaleString() : '—')
const FORMATS: { id: TaskFormat; label: string }[] = [
  { id: 'csv', label: 'CSV' },
  { id: 'tsv', label: 'TSV' },
  { id: 'json', label: 'JSON' },
  { id: 'insert', label: 'SQL INSERTs' },
  { id: 'xlsx', label: 'Excel (.xlsx)' },
]

interface Metric { size?: number; sessions?: number }

/** Server dashboard (model counts, database size, live sessions) plus recurring export tasks. */
export function AdminDialog() {
  const { adminOpen, connections, live, set, connect, refresh } = useWorkbench()
  const [tab, setTab] = useState<'overview' | 'tasks'>('overview')
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [metrics, setMetrics] = useState<Record<string, Metric>>({})
  const [draft, setDraft] = useState<TaskInput>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!adminOpen) return
    void ipc.tasks.list().then(setTasks).catch((e) => setError(clean(e)))
    return ipc.tasks.onChanged(setTasks)
  }, [adminOpen])

  // Metrics are read only for connected sources, so opening the dashboard never opens everything.
  useEffect(() => {
    if (!adminOpen || tab !== 'overview') return
    for (const c of connections) {
      if (live[c.id]?.status !== 'ready') continue
      const queries = dashboardQueries(connectionDialect(c, live[c.id]?.model))
      if (!queries.length) continue
      void (async () => {
        const next: Metric = {}
        for (const q of queries) {
          try {
            const r = await ipc.db.execute(c.id, q.sql, { limit: 1 })
            if (r.error) continue
            const value = metricValue(r.columns, r.rows, q.id === 'size' ? 'bytes' : 'sessions')
            if (q.id === 'size') next.size = value
            else next.sessions = value
          } catch { /* metrics are informational: a failed query leaves the value empty */ }
        }
        setMetrics((m) => ({ ...m, [c.id]: next }))
      })()
    }
  }, [adminOpen, tab, connections, live])

  const connectedCount = useMemo(() => connections.filter((c) => live[c.id]?.status === 'ready').length, [connections, live])
  if (!adminOpen) return null

  const close = () => set({ adminOpen: false })
  const startNew = () => {
    setError(undefined)
    setDraft({
      name: '', connectionId: connections[0]?.id ?? '', sql: 'select 1', format: 'csv',
      outputPath: '', everyMinutes: 60, enabled: true,
    })
  }
  const editTask = (task: ScheduledTask) => {
    setError(undefined)
    setDraft({
      id: task.id, name: task.name, connectionId: task.connectionId, sql: task.sql,
      format: task.format, outputPath: task.outputPath, everyMinutes: task.everyMinutes, enabled: task.enabled,
    })
  }
  const pickOutput = async () => {
    if (!draft) return
    const name = `${draft.name.trim() || 'export'}.${taskExtension(draft.format)}`
    const chosen = await ipc.tasks.chooseOutput(name, draft.format)
    if (chosen) setDraft({ ...draft, outputPath: chosen })
  }
  const save = async () => {
    if (!draft) return
    setBusy(true); setError(undefined)
    try {
      setTasks(await ipc.tasks.save(draft))
      setDraft(undefined)
    } catch (e) { setError(clean(e)) } finally { setBusy(false) }
  }
  const run = async (task: ScheduledTask) => {
    setBusy(true); setError(undefined)
    try { setTasks(await ipc.tasks.run(task.id)) }
    catch (e) { setError(clean(e)) } finally { setBusy(false) }
  }
  const remove = async (task: ScheduledTask) => {
    if (!window.confirm(`Delete the scheduled task "${task.name}"? The output file is kept.`)) return
    setError(undefined)
    try { setTasks(await ipc.tasks.remove(task.id)) } catch (e) { setError(clean(e)) }
  }
  const patchDraft = (patch: Partial<TaskInput>) => setDraft((d) => (d ? { ...d, ...patch } : d))

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section className="dialog admin-dialog" role="dialog" aria-label="Dashboard and scheduled tasks">
        <header>
          <Icon id="server" /> Dashboard
          <button type="button" aria-label="Close" onClick={close}><Icon id="close" /></button>
        </header>

        <div className="admin-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'overview'} className={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')}>
            <Icon id="server" /> Overview
          </button>
          <button role="tab" aria-selected={tab === 'tasks'} className={tab === 'tasks' ? 'on' : ''} onClick={() => setTab('tasks')}>
            <Icon id="history" /> Scheduled tasks
          </button>
          <span className="grow" />
          <span className="hint">{connectedCount}/{connections.length} connected</span>
        </div>

        {tab === 'overview' && (
          <div className="admin-overview">
            {!connections.length && <p className="admin-empty">Create a data source to see its dashboard.</p>}
            {connections.map((c) => {
              const state = live[c.id]
              const stats = modelStats(state?.model)
              const metric = metrics[c.id]
              return (
                <article className="admin-card" key={c.id}>
                  <div className="admin-card-head">
                    <Icon id="database" />
                    <strong>{c.name}</strong>
                    <span className={`admin-status ${state?.status ?? 'idle'}`}>{state?.status ?? 'not connected'}</span>
                    <span className="grow" />
                    {state?.status === 'ready'
                      ? <button type="button" onClick={() => void refresh(c.id)}><Icon id="refresh" /> Refresh</button>
                      : <button type="button" onClick={() => void connect(c.id)}><Icon id="plug" /> Connect</button>}
                  </div>
                  <div className="admin-metrics">
                    <div><b>{stats.schemas}</b><span>schemas</span></div>
                    <div><b>{stats.tables}</b><span>tables</span></div>
                    <div><b>{stats.views}</b><span>views</span></div>
                    <div><b>{stats.columns}</b><span>columns</span></div>
                    <div><b>{stats.foreignKeys}</b><span>foreign keys</span></div>
                    <div><b>{formatBytes(metric?.size)}</b><span>database size</span></div>
                    <div><b>{metric?.sessions ?? '—'}</b><span>sessions</span></div>
                  </div>
                  <div className="admin-card-foot">
                    <span>{c.kind.toUpperCase()}{state?.version ? ` · ${state.version}` : ''}</span>
                    {state?.error && <span className="error">{state.error}</span>}
                  </div>
                </article>
              )
            })}
          </div>
        )}

        {tab === 'tasks' && (
          <div className="admin-tasks">
            <div className="admin-task-actions">
              <button type="button" className="primary" onClick={startNew} disabled={!connections.length}><Icon id="add" /> New scheduled export</button>
              <span className="grow" />
              <span className="hint">Files are overwritten atomically on every run.</span>
            </div>

            {error && <p className="hint error"><Icon id="error" /> {error}</p>}

            {!tasks.length && !draft && <p className="admin-empty">No scheduled tasks yet. A task runs a SELECT every N minutes and writes CSV, TSV, JSON, SQL INSERTs or an Excel workbook.</p>}

            {tasks.length > 0 && (
              <div className="task-list" role="list">
                {tasks.map((task) => (
                  <div className="task-row" role="listitem" key={task.id}>
                    <div className="task-main">
                      <strong>{task.name}</strong>
                      <span className="hint">
                        {connections.find((c) => c.id === task.connectionId)?.name ?? task.connectionId} · every {task.everyMinutes} min · {task.format.toUpperCase()}
                      </span>
                      <span className="hint">{task.outputPath}</span>
                      {task.lastRun && (
                        <span className={`hint ${task.lastRun.ok ? 'ok' : 'error'}`}>
                          <Icon id={task.lastRun.ok ? 'pass-filled' : 'error'} /> {when(task.lastRun.at)} · {task.lastRun.message}
                        </span>
                      )}
                    </div>
                    <div className="task-side">
                      <span className="hint">{task.enabled ? `next ${when(task.nextRun)}` : 'disabled'}</span>
                      <div className="task-buttons">
                        <button type="button" title="Run now" disabled={busy} onClick={() => void run(task)}><Icon id="play" /></button>
                        <button type="button" title="Edit" onClick={() => editTask(task)}><Icon id="edit" /></button>
                        <button type="button" title="Delete" onClick={() => void remove(task)}><Icon id="trash" /></button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {draft && (
              <div className="task-form">
                <div className="task-form-grid">
                  <label><span>Name</span><input value={draft.name} placeholder="Nightly orders" onChange={(e) => patchDraft({ name: e.target.value })} /></label>
                  <label><span>Data source</span>
                    <select value={draft.connectionId} onChange={(e) => patchDraft({ connectionId: e.target.value })}>
                      {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </label>
                  <label><span>Every (minutes)</span><input type="number" min={1} max={10080} value={draft.everyMinutes} onChange={(e) => patchDraft({ everyMinutes: Number(e.target.value) })} /></label>
                  <label><span>Format</span>
                    <select value={draft.format} onChange={(e) => patchDraft({ format: e.target.value as TaskFormat })}>
                      {FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                    </select>
                  </label>
                  <label className="wide"><span>Output file</span>
                    <div className="with-btn"><input value={draft.outputPath} placeholder="/home/you/exports/orders.csv" onChange={(e) => patchDraft({ outputPath: e.target.value })} /><button type="button" onClick={() => void pickOutput()}>Choose…</button></div>
                  </label>
                </div>
                <label className="task-sql"><span>SQL</span>
                  <textarea value={draft.sql} spellCheck={false} rows={5} onChange={(e) => patchDraft({ sql: e.target.value })} />
                </label>
                <label className="task-enabled"><input type="checkbox" checked={draft.enabled} onChange={(e) => patchDraft({ enabled: e.target.checked })} /> Enabled</label>
                <div className="task-form-actions">
                  <button type="button" onClick={() => { setDraft(undefined); setError(undefined) }}>Cancel</button>
                  <button type="button" className="primary" disabled={busy} onClick={() => void save()}><Icon id="check" /> Save task</button>
                </div>
              </div>
            )}
          </div>
        )}

        <footer>
          <span className="hint">Scheduled tasks run while Stratum is open.</span>
          <span className="grow" />
          <button type="button" onClick={close}>Close</button>
        </footer>
      </section>
    </div>
  )
}
