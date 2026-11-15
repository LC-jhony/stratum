import { useEffect, useMemo, useRef, useState } from 'react'
import type { DriverKind } from '../../../../shared/types'
import { searchObjects, type SearchableConnection } from '../../../../core/objectSearch'
import { useWorkbench } from '../../store/workbench'
import { Icon } from '../../ui/Icon'

/** Cross-connection quick search (DataGrip's "Search Everywhere" for database objects). */
export function ObjectSearchDialog() {
  const { objectSearchOpen, set, connections, live, openTable } = useWorkbench()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!objectSearchOpen) return
    setQuery('')
    setActive(0)
    const t = setTimeout(() => input.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [objectSearchOpen])

  const searchable = useMemo<SearchableConnection[]>(
    () => connections.map((c) => ({ id: c.id, name: c.name, kind: c.kind as DriverKind, model: live[c.id]?.model })),
    [connections, live],
  )
  const hits = useMemo(() => searchObjects(searchable, query), [searchable, query])
  const loaded = connections.filter((c) => !!live[c.id]?.model).length

  useEffect(() => setActive(0), [query])
  if (!objectSearchOpen) return null

  const close = () => set({ objectSearchOpen: false })
  const open = (index: number) => {
    const hit = hits[index]
    if (!hit) return
    openTable(hit.connectionId, hit.table, hit.schema || undefined)
    close()
  }

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section className="dialog object-search" role="dialog" aria-label="Search database objects">
        <header>
          <Icon id="search" />
          <input
            ref={input}
            value={query}
            placeholder="Search tables, views, columns…  (schema.table or table.column)"
            aria-label="Search objects"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); close() }
              else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, hits.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
              else if (e.key === 'Enter') { e.preventDefault(); open(active) }
            }}
          />
          <button type="button" aria-label="Close" onClick={close}><Icon id="close" /></button>
        </header>
        <div className="object-list" role="listbox" aria-label="Matching objects">
          {!query.trim() && (
            <p className="hint"><Icon id="info" /> Type to search across {connections.length} data source{connections.length === 1 ? '' : 's'} ({loaded} with metadata loaded).</p>
          )}
          {!!query.trim() && !hits.length && <p className="hint"><Icon id="info" /> No matches. Connect a data source to include its objects.</p>}
          {hits.map((hit, i) => (
            <button
              key={`${hit.connectionId}-${hit.schema}-${hit.table}-${hit.column ?? ''}`}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`object-hit${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => open(i)}
            >
              <Icon id={hit.kind === 'view' ? 'eye' : 'table'} />
              <span className="object-name">
                {hit.table}
                {hit.column && <span className="object-column">.{hit.column}</span>}
              </span>
              <span className="object-where">{hit.connectionName}{hit.schema ? ` / ${hit.schema}` : ''}</span>
              {hit.columnType && <span className="badge-kind">{hit.columnType}</span>}
              {hit.match === 'column' && <span className="badge-kind">column</span>}
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
