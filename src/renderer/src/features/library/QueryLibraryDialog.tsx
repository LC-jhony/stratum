import { useEffect, useMemo, useState } from 'react'
import { ipc } from '../../ipc/client'
import type { SavedQuery } from '../../../../shared/types'
import { useWorkbench } from '../../store/workbench'
import { Icon } from '../../ui/Icon'

const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')

/** Named SQL statements ("SQL scripts") shared across data sources. */
export function QueryLibraryDialog() {
  const { libraryOpen, set, connections, openConsole } = useWorkbench()
  const [queries, setQueries] = useState<SavedQuery[]>([])
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string>()

  const load = async () => {
    try { setQueries(await ipc.library.list()); setError(undefined) }
    catch (e) { setError(clean(e)) }
  }
  useEffect(() => { if (libraryOpen) { setFilter(''); void load() } }, [libraryOpen])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? queries.filter((x) => x.name.toLowerCase().includes(q) || x.sql.toLowerCase().includes(q)) : queries
  }, [queries, filter])
  if (!libraryOpen) return null

  const close = () => set({ libraryOpen: false })
  const open = (q: SavedQuery) => {
    const target = q.connectionId && connections.some((c) => c.id === q.connectionId) ? q.connectionId : undefined
    openConsole(target, q.sql)
    close()
  }
  const remove = async (q: SavedQuery) => {
    if (!window.confirm(`Delete the saved query "${q.name}"?`)) return
    try { await ipc.library.remove(q.id); await load() }
    catch (e) { setError(clean(e)) }
  }
  const rename = async (q: SavedQuery) => {
    const name = window.prompt('New name', q.name)?.trim()
    if (!name || name === q.name) return
    try { await ipc.library.save({ ...q, name }); await load() }
    catch (e) { setError(clean(e)) }
  }

  const connName = (id?: string) => (id ? connections.find((c) => c.id === id)?.name : undefined)

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section className="dialog library-dialog" role="dialog" aria-label="Saved queries">
        <header><Icon id="file-down" /> Saved queries<button type="button" aria-label="Close" onClick={close}><Icon id="close" /></button></header>
        <div className="filter"><Icon id="search" /><input autoFocus placeholder="Filter by name or SQL" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
        {error && <p className="hint error"><Icon id="triangle-alert" />{error}</p>}
        <div className="library-list">
          {!shown.length && <p className="hint"><Icon id="info" /> {queries.length ? 'No saved query matches the filter.' : 'No saved queries yet. Use “Save to query library” in a SQL console.'}</p>}
          {shown.map((q) => (
            <div className="library-row" key={q.id}>
              <button type="button" className="library-main" onClick={() => open(q)} title={q.sql}>
                <span className="library-name">{q.name}</span>
                <span className="library-sql">{q.sql.replace(/\s+/g, ' ').slice(0, 140)}</span>
                <span className="library-meta">
                  {connName(q.connectionId) ?? 'Any data source'} · {new Date(q.updatedAt).toLocaleString()}
                </span>
              </button>
              <button type="button" title="Rename" onClick={() => void rename(q)}><Icon id="pencil" /></button>
              <button type="button" title="Delete" onClick={() => void remove(q)}><Icon id="close" /></button>
            </div>
          ))}
        </div>
        <footer><span className="grow" /><span className="hint">{queries.length} saved</span><button className="primary" onClick={close}>Close</button></footer>
      </section>
    </div>
  )
}
