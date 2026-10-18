import { useMemo, useState } from 'react'
import type { ConnectionView, TableInfo } from '../../../shared/types'
import { connectionDialect } from '../../../shared/dialects'
import { isSqlKind } from '../../../shared/kinds'
import { qualify, quote } from '../../../shared/quoting'
import { useWorkbench } from '../store/workbench'
import { Icon } from './Icon'

type Kind = 'connection' | 'schema' | 'group' | 'table' | 'view' | 'column' | 'index'
interface Row { key: string; depth: number; kind: Kind; label: string; detail?: string; expandable: boolean; icon: string; color?: string; conn: ConnectionView; schema?: string; table?: string; pk?: boolean; fk?: boolean; extra?: string }

export function Explorer() {
  const { connections, live, connect, refresh, openConsole, openTable, openDiagram, set, disconnect, removeConnection, setActive } = useWorkbench()
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [sel, setSel] = useState<string>()
  const [filter, setFilter] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; row: Row } | null>(null)
  const [rename, setRename] = useState<{ row: Row; value: string } | null>(null)
  const [usages, setUsages] = useState<{ row: Row; hits: { tabId: string; title: string; line: number; text: string }[] } | null>(null)
  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); n.has(k) ? n.delete(k) : n.add(k); return n })

  const rows = useMemo(() => {
    const out: Row[] = []
    const f = filter.trim().toLowerCase()
    for (const conn of connections) {
      const l = live[conn.id], ck = conn.id
      out.push({ key: ck, depth: 0, kind: 'connection', label: conn.name, detail: l?.version ? `${conn.kind} ${l.version}` : conn.kind, expandable: true, icon: l?.status === 'ready' ? 'database' : l?.status === 'error' ? 'error' : 'server', color: l?.status === 'ready' ? 'var(--vscode-charts-green)' : l?.status === 'error' ? 'var(--vscode-errorForeground)' : undefined, conn })
      if (!open.has(ck)) continue
      const model = l?.model
      if (l?.status === 'connecting' || l?.loadingModel) out.push({ key: `${ck}/loading`, depth: 1, kind: 'group', label: l?.status === 'connecting' ? 'Connecting…' : 'Introspecting…', expandable: false, icon: 'loading', conn })
      if (l?.status === 'error') out.push({ key: `${ck}/err`, depth: 1, kind: 'group', label: l.error ?? 'Connection failed', expandable: false, icon: 'warning', color: 'var(--vscode-errorForeground)', conn })
      for (const s of model?.schemas ?? []) {
        const sk = `${ck}/${s.name}`
        const tables = s.tables.filter((t) => !f || t.name.toLowerCase().includes(f))
        if (f && !tables.length) continue
        out.push({ key: sk, depth: 1, kind: 'schema', label: s.name, detail: String(tables.length), expandable: true, icon: 'symbol-namespace', conn, schema: s.name })
        if (!open.has(sk) && !f) continue
        for (const t of tables) {
          const tk = `${sk}/${t.name}`
          out.push({ key: tk, depth: 2, kind: t.kind, label: t.name, expandable: true, icon: t.kind === 'view' ? 'eye' : 'table', color: 'var(--vscode-charts-blue)', conn, schema: s.name, table: t.name })
          if (!open.has(tk)) continue
          pushChildren(out, t, tk, conn, s.name)
        }
      }
    }
    return out
  }, [connections, live, open, filter])

  const activate = (r: Row) => {
    if (r.kind === 'connection') { toggle(r.key); void connect(r.conn.id); if (!open.has(r.key)) setOpen((o) => new Set(o).add(r.key)) }
    else if (r.expandable) toggle(r.key)
    if ((r.kind === 'table' || r.kind === 'view') && r.table) openTable(r.conn.id, r.table, r.schema)
  }

  const dialectOf = (connId: string) => connectionDialect(connections.find((c) => c.id === connId), live[connId]?.model)

  /** Light "Find Usages": occurrences of the object's name in the open SQL consoles of the same data source. */
  const collectUsages = (row: Row) => {
    const hits: { tabId: string; title: string; line: number; text: string }[] = []
    const re = new RegExp(`\\b${row.table!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    for (const t of useWorkbench.getState().tabs) {
      if (t.type !== 'console' || t.connectionId !== row.conn.id) continue
      t.sql.split('\n').forEach((text, i) => { if (re.test(text)) hits.push({ tabId: t.id, title: t.title, line: i + 1, text: text.trim().slice(0, 120) }) })
    }
    setUsages({ row, hits })
  }

  /** Light "Rename": generate the dialect-correct rename statement in a new console (never executed here). */
  const generateRename = () => {
    if (!rename) return
    const { row } = rename
    const name = rename.value.trim()
    setRename(null)
    if (!name || name === row.table) return
    const dialect = dialectOf(row.conn.id)
    const stmt = dialect === 'mssql'
      ? `exec sp_rename '${row.schema ? `${row.schema}.` : ''}${row.table}', '${name}';`
      : dialect === 'mysql' || dialect === 'mariadb'
        ? `rename table ${qualify(dialect, row.schema, row.table!)} to ${quote(dialect, name)};`
        : `alter table ${qualify(dialect, row.schema, row.table!)} rename to ${quote(dialect, name)};`
    openConsole(row.conn.id, `-- Rename ${row.table} → ${name} (SQL generated, not executed)\n${stmt}\n`)
  }

  const canRename = (r: Row) => {
    const d = dialectOf(r.conn.id)
    if (d === 'cassandra') return false
    if (r.kind === 'table') return true
    return ['postgres', 'greenplum', 'cockroach', 'redshift', 'vertica', 'oracle', 'db2', 'snowflake', 'h2', 'hsql', 'generic'].includes(d)
  }
  const onKey = (e: React.KeyboardEvent) => {
    const i = rows.findIndex((r) => r.key === sel), r = rows[i]
    if (e.key === 'ArrowDown') setSel(rows[Math.min(i + 1, rows.length - 1)]?.key)
    else if (e.key === 'ArrowUp') setSel(rows[Math.max(i - 1, 0)]?.key)
    else if (e.key === 'ArrowRight' && r?.expandable && !open.has(r.key)) { r.kind === 'connection' ? activate(r) : toggle(r.key) }
    else if (e.key === 'ArrowLeft' && r?.expandable && open.has(r.key)) toggle(r.key)
    else if (e.key === 'Enter' && r) activate(r)
    else return
    e.preventDefault()
  }

  return (
    <aside className="explorer" onClick={() => setMenu(null)}>
      <header className="pane-title">
        <span>Database Explorer</span>
        <div className="pane-actions">
          <button title="New Data Source…" onClick={() => set({ dialog: {} })}><Icon id="add" /></button>
          <button title="Refresh" onClick={() => connections.forEach((c) => live[c.id]?.status === 'ready' && void refresh(c.id))}><Icon id="refresh" /></button>
          <button title="New Query Console" onClick={() => openConsole(sel ? rows.find((r) => r.key === sel)?.conn.id : undefined)}><Icon id="terminal" /></button>
        </div>
      </header>
      <div className="filter"><Icon id="filter" /><input placeholder="Filter tables" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
      <div className="explorer-tree" tabIndex={0} onKeyDown={onKey} role="tree">
        {!connections.length && <div className="empty-state"><p>No data sources yet.</p><button className="primary" onClick={() => set({ dialog: {} })}>New Data Source…</button></div>}
        {rows.map((r) => (
          <div key={r.key} role="treeitem" aria-expanded={r.expandable ? open.has(r.key) : undefined} className={`row ${sel === r.key ? 'selected' : ''}`} style={{ paddingLeft: 8 + r.depth * 14 }}
            onClick={(e) => { e.stopPropagation(); setSel(r.key); if (r.kind === 'connection' || r.kind === 'schema' || r.kind === 'group') activate(r) }}
            onDoubleClick={() => (r.kind === 'table' || r.kind === 'view') ? openTable(r.conn.id, r.table!, r.schema) : undefined}
            onContextMenu={(e) => { e.preventDefault(); setSel(r.key); setMenu({ x: e.clientX, y: e.clientY, row: r }) }}>
            <span className="chev" onClick={(e) => { e.stopPropagation(); if (r.expandable) r.kind === 'connection' ? activate(r) : toggle(r.key) }}>{r.expandable ? <Icon id={open.has(r.key) ? 'chevron-down' : 'chevron-right'} /> : null}</span>
            <Icon id={r.icon} className={r.icon === 'loading' ? 'codicon-modifier-spin' : ''} style={{ color: r.color }} />
            <span className="label">{r.label}</span>
            {r.extra && <span className="badge-kind">{r.extra}</span>}
            {r.detail && <span className="detail">{r.detail}</span>}
          </div>
        ))}
      </div>
      {menu && (
        <ul className="menu" style={{ left: menu.x, top: menu.y }}>
          {menu.row.kind === 'connection' && <>
            <li onClick={() => void connect(menu.row.conn.id)}><Icon id="plug" />Connect</li>
            <li onClick={() => openConsole(menu.row.conn.id)}><Icon id="terminal" />New Query Console</li>
            {isSqlKind(menu.row.conn.kind) && <li onClick={() => openDiagram(menu.row.conn.id)}><Icon id="type-hierarchy" />Show Diagram</li>}
            <li onClick={() => void refresh(menu.row.conn.id)}><Icon id="refresh" />Refresh</li>
            <hr />
            <li onClick={() => set({ dialog: { editing: menu.row.conn } })}><Icon id="settings-gear" />Properties…</li>
            <li onClick={() => void disconnect(menu.row.conn.id)}><Icon id="debug-disconnect" />Disconnect</li>
            <li className="danger" onClick={() => void removeConnection(menu.row.conn.id)}><Icon id="trash" />Remove</li>
          </>}
          {(menu.row.kind === 'table' || menu.row.kind === 'view') && <>
            <li onClick={() => openTable(menu.row.conn.id, menu.row.table!, menu.row.schema)}><Icon id="table" />Open Data Editor</li>
            {isSqlKind(menu.row.conn.kind) && <>
              <li onClick={() => openDiagram(menu.row.conn.id, { schemas: menu.row.schema ? [menu.row.schema] : undefined, focus: { table: menu.row.table!, depth: 1 } })}><Icon id="type-hierarchy" />Show Diagram (neighbours)</li>
              <li onClick={() => openConsole(menu.row.conn.id, `select * from ${menu.row.table};\n`)}><Icon id="terminal" />Select * in Console</li>
            </>}
            <li onClick={() => void navigator.clipboard.writeText(menu.row.table!)}><Icon id="copy" />Copy Name</li>
            {isSqlKind(menu.row.conn.kind) && canRename(menu.row) && <li onClick={() => { setRename({ row: menu.row, value: menu.row.table! }); setMenu(null) }}><Icon id="edit" />Rename…</li>}
            {isSqlKind(menu.row.conn.kind) && <li onClick={() => { setMenu(null); collectUsages(menu.row) }}><Icon id="search" />Find Usages</li>}
          </>}
          {menu.row.kind === 'schema' && isSqlKind(menu.row.conn.kind) && <li onClick={() => openDiagram(menu.row.conn.id, { schemas: [menu.row.schema!] })}><Icon id="type-hierarchy" />Show Diagram</li>}
        </ul>
      )}
      {rename && (
        <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && setRename(null)}>
          <div className="dialog rename-dialog" role="dialog" aria-label="Rename object">
            <header><Icon id="edit" /> Rename {rename.row.table}<button onClick={() => setRename(null)}><Icon id="close" /></button></header>
            <div className="form">
              <label className="field span-2"><span>New name</span>
                <input autoFocus value={rename.value} onChange={(e) => setRename({ ...rename, value: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && generateRename()} />
              </label>
              <p className="hint"><Icon id="info" /> Generates the rename SQL in a new console — nothing runs until you execute it.</p>
            </div>
            <footer><span className="grow" /><button onClick={() => setRename(null)}>Cancel</button><button className="primary" onClick={generateRename}>Generate SQL</button></footer>
          </div>
        </div>
      )}
      {usages && (
        <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && setUsages(null)}>
          <div className="dialog find-usages" role="dialog" aria-label="Find usages">
            <header><Icon id="search" /> Usages of {usages.row.table} ({usages.hits.length})<button onClick={() => setUsages(null)}><Icon id="close" /></button></header>
            <div className="usages">
              {!usages.hits.length && <p className="hint"><Icon id="info" /> No usages in the open SQL consoles.</p>}
              {usages.hits.map((h, i) => (
                <button key={i} className="usage" onClick={() => { setActive(h.tabId); setUsages(null) }}>
                  <span className="where">{h.title}:{h.line}</span><code>{h.text}</code>
                </button>
              ))}
            </div>
            <footer><span className="grow" /><button className="primary" onClick={() => setUsages(null)}>Close</button></footer>
          </div>
        </div>
      )}
    </aside>
  )
}

function pushChildren(out: Row[], t: TableInfo, tk: string, conn: ConnectionView, schema: string) {
  for (const c of t.columns) out.push({ key: `${tk}/c/${c.name}`, depth: 3, kind: 'column', label: c.name, detail: c.dataType + (c.nullable ? '' : ' • not null'), expandable: false, icon: c.isPrimaryKey ? 'key' : t.foreignKeys.some((f) => f.columns.includes(c.name)) ? 'references' : 'symbol-field', color: c.isPrimaryKey ? 'var(--vscode-charts-yellow)' : t.foreignKeys.some((f) => f.columns.includes(c.name)) ? 'var(--vscode-charts-blue)' : 'var(--vscode-descriptionForeground)', conn, schema, table: t.name })
  for (const i of t.indexes) out.push({ key: `${tk}/i/${i.name}`, depth: 3, kind: 'index', label: i.name, detail: `(${i.columns.join(', ')})`, extra: i.unique ? 'unique' : undefined, expandable: false, icon: 'list-ordered', conn, schema, table: t.name })
}
