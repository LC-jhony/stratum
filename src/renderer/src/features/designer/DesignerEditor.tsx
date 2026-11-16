import { useMemo, useState } from 'react'
import { connectionDialect } from '../../../../core/dialects'
import { columnTypes, createTableSql, type DesignerColumn } from '../../../../core/ddl'
import { isSqlKind } from '../../../../core/kinds'
import { ipc } from '../../ipc/client'
import { useWorkbench, type DesignerTab } from '../../store/workbench'
import { Icon } from '../../ui/Icon'

const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')

/** Visual table designer: columns in, CREATE TABLE out, create-and-open in one step. */
export function DesignerEditor({ tab }: { tab: DesignerTab }) {
  const { connections, live, refresh, openTable, closeTab, patchTab } = useWorkbench()
  const conn = connections.find((c) => c.id === tab.connectionId)
  const model = live[tab.connectionId]?.model
  const dialect = connectionDialect(conn, model)
  const types = useMemo(() => columnTypes(dialect), [dialect])
  const [schema, setSchema] = useState(tab.schema ?? '')
  const [name, setName] = useState('')
  const [columns, setColumns] = useState<DesignerColumn[]>([
    { name: 'id', type: types[1] ?? 'integer', nullable: false, primaryKey: true },
    { name: '', type: types[0] ?? 'text', nullable: true, primaryKey: false },
  ])
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>()

  const ddl = useMemo(() => {
    try { return createTableSql(dialect, { schema: schema.trim() || undefined, name, columns }) }
    catch (e) { return `-- ${clean(e)}` }
  }, [dialect, schema, name, columns])

  const patch = (i: number, change: Partial<DesignerColumn>) => setColumns((cols) => cols.map((c, j) => (j === i ? { ...c, ...change } : c)))
  const add = () => setColumns((cols) => [...cols, { name: '', type: types[0] ?? 'text', nullable: true, primaryKey: false }])
  const remove = (i: number) => setColumns((cols) => (cols.length > 1 ? cols.filter((_c, j) => j !== i) : cols))
  const rename = (value: string) => { setName(value); patchTab(tab.id, { title: value.trim() || 'New table' }) }

  const create = async () => {
    setBusy(true); setError(undefined)
    try {
      if (!isSqlKind(conn?.kind)) throw new Error('The table designer needs a SQL data source.')
      const sql = createTableSql(dialect, { schema: schema.trim() || undefined, name, columns })
      const out = await ipc.db.execute(tab.connectionId, sql)
      if (out.error) throw new Error(out.error)
      await refresh(tab.connectionId)
      closeTab(tab.id)
      openTable(tab.connectionId, name.trim(), schema.trim() || undefined)
    } catch (e) { setError(clean(e)) } finally { setBusy(false) }
  }

  return (
    <div className="designer">
      <div className="editor-card">
        <div className="editor-toolbar">
          <Icon id="table" />
          <span className="designer-title">New table</span>
          <span className="grow" />
          <button className="primary" type="button" disabled={busy} onClick={() => void create()}><Icon id={busy ? 'loading' : 'check'} className={busy ? 'codicon-modifier-spin' : undefined} /> Create table</button>
        </div>
        <div className="designer-form">
          <label><span>Schema</span><input value={schema} placeholder="default schema" onChange={(e) => setSchema(e.target.value)} /></label>
          <label><span>Table name</span><input value={name} placeholder="new_table" autoFocus onChange={(e) => rename(e.target.value)} /></label>
        </div>
        <div className="designer-grid" role="table" aria-label="Columns">
          <div className="designer-row head" role="row">
            <span>Name</span><span>Type</span><span>Not null</span><span>Primary key</span><span>Unique</span><span>Default</span><span />
          </div>
          {columns.map((c, i) => (
            <div className="designer-row" role="row" key={i}>
              <input value={c.name} placeholder="column" aria-label={`Column ${i + 1} name`} onChange={(e) => patch(i, { name: e.target.value })} />
              <input value={c.type} list="designer-types" aria-label={`Column ${i + 1} type`} onChange={(e) => patch(i, { type: e.target.value })} />
              <input type="checkbox" checked={!c.nullable} aria-label={`Column ${i + 1} not null`} onChange={(e) => patch(i, { nullable: !e.target.checked })} />
              <input type="checkbox" checked={c.primaryKey} aria-label={`Column ${i + 1} primary key`} onChange={(e) => patch(i, { primaryKey: e.target.checked, nullable: e.target.checked ? false : c.nullable })} />
              <input type="checkbox" checked={!!c.unique} aria-label={`Column ${i + 1} unique`} onChange={(e) => patch(i, { unique: e.target.checked })} />
              <input value={c.default ?? ''} placeholder="e.g. now()" aria-label={`Column ${i + 1} default`} onChange={(e) => patch(i, { default: e.target.value })} />
              <button type="button" title="Remove column" disabled={columns.length === 1} onClick={() => remove(i)}><Icon id="trash" /></button>
            </div>
          ))}
          <datalist id="designer-types">{types.map((t) => <option key={t} value={t} />)}</datalist>
        </div>
        <div className="designer-actions"><button type="button" onClick={add}><Icon id="add" /> Add column</button></div>
        {error && <p className="hint error"><Icon id="triangle-alert" /> {error}</p>}
        <pre className="designer-ddl" aria-label="CREATE TABLE preview">{ddl}</pre>
      </div>
    </div>
  )
}
