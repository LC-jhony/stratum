import { useCallback, useEffect, useState } from 'react'
import { ipc } from '../../ipc/client'
import type { SessionInfo } from '../../../../shared/types'
import { useWorkbench } from '../../store/workbench'
import { Icon } from '../../ui/Icon'

const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')

/** Server sessions and locks (PostgreSQL pg_stat_activity / MySQL processlist). */
export function SessionMonitorDialog() {
  const { sessionMonitor, set, connections } = useWorkbench()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [auto, setAuto] = useState(true)
  const [filter, setFilter] = useState('')
  const conn = connections.find((c) => c.id === sessionMonitor)

  const load = useCallback(async () => {
    if (!sessionMonitor) return
    setBusy(true)
    try { setSessions(await ipc.db.sessions(sessionMonitor)); setError(undefined) }
    catch (e) { setError(clean(e)) }
    finally { setBusy(false) }
  }, [sessionMonitor])

  useEffect(() => {
    if (!sessionMonitor) return
    setSessions([])
    setError(undefined)
    setFilter('')
    void load()
  }, [sessionMonitor, load])
  useEffect(() => {
    if (!sessionMonitor || !auto) return
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [sessionMonitor, auto, load])

  if (!sessionMonitor) return null
  const close = () => set({ sessionMonitor: undefined })
  const kill = async (s: SessionInfo) => {
    if (!window.confirm(`Terminate session ${s.pid}${s.user ? ` (${s.user})` : ''}?`)) return
    try { await ipc.db.killSession(sessionMonitor, s.pid); await load() }
    catch (e) { setError(clean(e)) }
  }

  const q = filter.trim().toLowerCase()
  const shown = q ? sessions.filter((s) => [s.pid, s.user, s.database, s.state, s.query, s.client, s.wait].some((v) => String(v ?? '').toLowerCase().includes(q))) : sessions
  const blocked = sessions.filter((s) => (s.blockedBy?.length ?? 0) > 0).length

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section className="dialog session-dialog" role="dialog" aria-label="Server sessions">
        <header>
          <Icon id="server" /> Sessions &amp; locks — {conn?.name ?? sessionMonitor}
          <button type="button" aria-label="Close" onClick={close}><Icon id="close" /></button>
        </header>
        <div className="session-tools">
          <div className="filter"><Icon id="search" /><input placeholder="Filter by user, database, state or SQL" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
          <button type="button" disabled={busy} onClick={() => void load()}><Icon id="refresh" />Refresh</button>
          <label className="session-auto"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />Auto (5 s)</label>
          <span className="hint">{sessions.length} session{sessions.length === 1 ? '' : 's'}{blocked ? ` · ${blocked} blocked` : ''}</span>
        </div>
        {error && <p className="hint error"><Icon id="triangle-alert" />{error}</p>}
        <div className="session-scroll">
          <table className="session-table">
            <thead><tr><th>PID</th><th>User</th><th>Database</th><th>State</th><th>Client</th><th>Time</th><th>Query</th><th /></tr></thead>
            <tbody>
              {shown.map((s) => (
                <tr key={String(s.pid)} className={s.current ? 'current' : undefined}>
                  <td>{s.pid}{s.current && <span className="badge-kind">this session</span>}</td>
                  <td>{s.user ?? '—'}</td>
                  <td>{s.database ?? '—'}</td>
                  <td className={s.blockedBy?.length ? 'blocked' : undefined}>{s.state ?? '—'}{s.wait ? <span className="session-wait">{s.wait}</span> : null}</td>
                  <td className="session-client" title={s.client}>{s.client ?? '—'}</td>
                  <td>{s.seconds !== undefined ? `${s.seconds}s` : s.startedAt ? new Date(s.startedAt).toLocaleTimeString() : '—'}</td>
                  <td className="session-sql" title={s.query}>{s.query?.replace(/\s+/g, ' ').slice(0, 160) || '—'}</td>
                  <td><button type="button" className="danger" disabled={s.current || busy} title={s.current ? 'Use Disconnect / Stop in the console' : 'Terminate this session'} onClick={() => void kill(s)}>Kill</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!shown.length && !error && <p className="hint"><Icon id="info" /> {sessions.length ? 'No session matches the filter.' : busy ? 'Loading…' : 'No sessions reported.'}</p>}
        </div>
        <footer><span className="grow" /><button className="primary" onClick={close}>Close</button></footer>
      </section>
    </div>
  )
}
