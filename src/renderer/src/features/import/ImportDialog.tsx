import { useEffect, useMemo, useState } from 'react'
import { connectionDialect } from '../../../../core/dialects'
import { autoMapping, csvTable, insertStatements, jsonTable, mappedRows, xlsxTables, type ImportValue, type TabularData } from '../../../../core/dataImport'
import { isSqlKind } from '../../../../core/kinds'
import { confirmsWrites } from '../../../../core/profiles'
import { qualify } from '../../../../core/quoting'
import { scriptStatements, summarizeScript } from '../../../../core/importSql'
import type { ConnectionView, TableInfo } from '../../../../shared/types'
import { ipc } from '../../ipc/client'
import { useWorkbench } from '../../store/workbench'
import { Icon } from '../../ui/Icon'

const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
const FILTERS = [{ name: 'Data files', extensions: ['csv', 'tsv', 'txt', 'json', 'sql', 'xlsx', 'xls', 'xlsm'] }]
const MAX_COPY_ROWS = 50_000

interface Source {
  name: string
  kind: 'data' | 'sql'
  data?: TabularData
  sql?: string
  /** Sheet selector only for XLSX workbooks. */
  sheets?: { name: string; headers: string[]; rows: ImportValue[][] }[]
  sheet?: string
}

const tableKey = (schema: string, table: string) => `${schema}\u0000${table}`
const parseKey = (key: string) => key.split('\u0000') as [string, string]

/** Import wizard: file or another data source → mapped INSERTs into the selected table. */
export function ImportDialog() {
  const { importRequest, connections, live, connect, refresh, set } = useWorkbench()
  const [source, setSource] = useState<Source>()
  const [targetId, setTargetId] = useState(importRequest?.connectionId ?? '')
  const [targetKey, setTargetKey] = useState('')
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [copyId, setCopyId] = useState(''), [copyKey, setCopyKey] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [done, setDone] = useState<string>()
  const [showSql, setShowSql] = useState(false)
  const [copyNote, setCopyNote] = useState<string>()

  const target = connections.find((c) => c.id === targetId)
  const targetModel = targetId ? live[targetId]?.model : undefined
  const dialect = connectionDialect(target, targetModel)
  const tableOptions = useMemo(() => (targetModel?.schemas ?? []).flatMap((s) => s.tables.map((t) => ({ key: tableKey(s.name, t.name), schema: s.name, table: t.name }))), [targetModel])
  const selected = tableOptions.find((t) => t.key === targetKey)
  const info: TableInfo | undefined = selected ? targetModel?.schemas.find((s) => s.name === selected.schema)?.tables.find((t) => t.name === selected.table) : undefined
  const targetSql = useMemo(() => (selected ? qualify(dialect, dialect === 'sqlite' ? undefined : selected.schema, selected.table) : ''), [selected, dialect])
  const headers = source?.data?.headers ?? []

  useEffect(() => {
    if (!importRequest) return
    setSource(undefined); setMapping({}); setTargetKey(''); setError(undefined); setDone(undefined); setShowSql(false); setCopyNote(undefined)
    setTargetId(importRequest.connectionId)
    if (importRequest.table) {
      const preset = importRequest.schema
        ? tableKey(importRequest.schema, importRequest.table)
        : tableOptions.find((t) => t.table === importRequest.table)?.key
      if (preset) setTargetKey(preset)
    }
  }, [importRequest])

  // Resolve a preset table once the target connection has loaded its model.
  useEffect(() => {
    if (targetKey || !importRequest?.table) return
    const key = importRequest.schema ? tableKey(importRequest.schema, importRequest.table) : tableOptions.find((t) => t.table === importRequest.table)?.key
    if (key) setTargetKey(key)
  }, [tableOptions, importRequest, targetKey])

  useEffect(() => {
    if (!targetId) return
    if (!live[targetId] || live[targetId].status === 'error') void connect(targetId)
  }, [targetId])

  // Map same-named columns whenever the source table or target table changes.
  useEffect(() => {
    if (!info) { setMapping({}); return }
    const auto = autoMapping(headers, info.columns.map((c) => c.name))
    setMapping(Object.fromEntries(info.columns.map((c, i) => [c.name, auto[i] ?? ''])))
  }, [info?.name, info?.columns.length, headers.join('\u0000')])

  if (!importRequest) return null

  const close = () => set({ importRequest: undefined })

  const loadFile = async () => {
    setBusy(true); setError(undefined); setDone(undefined)
    try {
      const file = await ipc.dialogs.openImport(FILTERS)
      if (!file) return
      const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
      if (file.base64) {
        const sheets = xlsxTables(file.base64)
        if (!sheets.length) throw new Error('The workbook has no sheets.')
        setSource({ name: file.name, kind: 'data', data: sheets[0], sheets, sheet: sheets[0].name })
      } else if (ext === 'json') {
        setSource({ name: file.name, kind: 'data', data: jsonTable(file.text ?? '') })
      } else if (ext === 'sql') {
        setSource({ name: file.name, kind: 'sql', sql: file.text ?? '' })
      } else {
        setSource({ name: file.name, kind: 'data', data: csvTable(file.text ?? '') })
      }
    } catch (e) { setError(clean(e)) } finally { setBusy(false) }
  }

  const loadCopy = async () => {
    if (!copyId || !copyKey) return
    const [schema, table] = parseKey(copyKey)
    const conn = connections.find((c) => c.id === copyId)
    const model = live[copyId]?.model
    const d = connectionDialect(conn, model)
    const sql = `select * from ${qualify(d, d === 'sqlite' ? undefined : schema, table)}`
    setBusy(true); setError(undefined); setDone(undefined); setCopyNote(undefined)
    try {
      await connect(copyId)
      const rows: ImportValue[][] = []
      let columns: string[] = [], offset = 0, hasMore = true, truncated = false
      while (hasMore) {
        const page = await ipc.db.execute(copyId, sql, { limit: 1000, offset })
        if (page.error) throw new Error(page.error)
        if (!columns.length) columns = page.columns.map((c) => c.name)
        for (const row of page.rows) {
          if (rows.length >= MAX_COPY_ROWS) { truncated = true; break }
          rows.push(row.map((v) => (v === null || v === undefined ? null : typeof v === 'number' || typeof v === 'boolean' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v))))
        }
        hasMore = page.hasMore && !truncated
        offset += page.rows.length
        if (!page.rows.length) break
      }
      setSource({ name: `${conn?.name ?? copyId} · ${table}`, kind: 'data', data: { headers: columns, rows } })
      if (truncated) setCopyNote(`Only the first ${MAX_COPY_ROWS.toLocaleString()} rows were copied.`)
    } catch (e) { setError(clean(e)) } finally { setBusy(false) }
  }

  const mapped = info && source?.kind === 'data'
    ? info.columns
      .map((c) => ({ column: c.name, sourceIndex: mapping[c.name] ? headers.indexOf(mapping[c.name]) : -1 }))
      .filter((m) => m.sourceIndex >= 0)
    : []
  const rows = info && source?.kind === 'data' ? mappedRows(source.data!, mapped) : []
  const statements = info && source?.kind === 'data' && mapped.length
    ? insertStatements({ target: targetSql, dialect, columns: mapped.map((m) => m.column), rows })
    : []
  const missingRequired = info?.columns.filter((c) => !c.nullable && c.default == null && !c.isPrimaryKey && !mapping[c.name]) ?? []

  const chooseSheet = (name: string) => {
    const sheet = source?.sheets?.find((s) => s.name === name)
    if (sheet) setSource({ ...source!, data: sheet, sheet: name })
  }

  const execute = async () => {
    if (!target) return
    setBusy(true); setError(undefined); setDone(undefined)
    try {
      if (source?.kind === 'sql') {
        const stmts = scriptStatements(source.sql ?? '')
        if (!stmts.length) throw new Error('The script has no executable statements.')
        if (confirmsWrites(target) && !window.confirm(`${target.name} is protected: run ${stmts.length} statement(s)?`)) return
        const out = await ipc.db.submit(targetId, stmts)
        if (!out.ok) throw new Error(out.error)
        setDone(`${stmts.length} statement(s) executed.`)
      } else {
        if (!info || !mapped.length) throw new Error('Choose a target table and map at least one column.')
        if (missingRequired.length) throw new Error(`Required columns are not mapped: ${missingRequired.map((c) => c.name).join(', ')}.`)
        if (!rows.length) throw new Error('The source has no rows to import.')
        if (confirmsWrites(target) && !window.confirm(`${target.name} is protected: insert ${rows.length} row(s) into ${selected!.table}?`)) return
        let imported = 0
        for (const statement of statements) {
          const out = await ipc.db.submit(targetId, [statement])
          if (!out.ok) throw new Error(`${out.error} (${imported} row(s) imported before the failure)`)
          imported += Math.min(200, rows.length - imported)
        }
        setDone(`${rows.length} row(s) imported into ${selected!.table}.`)
        void refresh(targetId)
      }
    } catch (e) { setError(clean(e)) } finally { setBusy(false) }
  }

  const canRun = source?.kind === 'sql' ? !!source.sql?.trim() : !!info && mapped.length > 0 && rows.length > 0

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section className="dialog import-dialog" role="dialog" aria-label="Import data">
        <header><Icon id="cloud-upload" /> Import Data<button type="button" aria-label="Close" onClick={close}><Icon id="close" /></button></header>

        <div className="import-target">
          <label><span>Target data source</span>
            <select value={targetId} onChange={(e) => { setTargetId(e.target.value); setTargetKey('') }}>
              {connections.map((c: ConnectionView) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          {source?.kind !== 'sql' && (
            <label><span>Target table</span>
              <select value={targetKey} onChange={(e) => setTargetKey(e.target.value)}>
                <option value="">— choose a table —</option>
                {tableOptions.map((t) => <option key={t.key} value={t.key}>{t.schema ? `${t.schema}.` : ''}{t.table}</option>)}
              </select>
            </label>
          )}
          {!targetModel && <span className="hint"><Icon id="loading" className="codicon-modifier-spin" /> Loading schema…</span>}
        </div>

        <div className="import-source">
          <div className="import-actions">
            <button type="button" onClick={() => void loadFile()} disabled={busy}><Icon id="file" /> Choose file…</button>
            <span className="sep" />
            <select value={copyId} onChange={(e) => { setCopyId(e.target.value); setCopyKey('') }} aria-label="Source data source">
              <option value="">Copy from data source…</option>
              {connections.filter((c) => c.id !== targetId && live[c.id]?.model).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value={copyKey} onChange={(e) => setCopyKey(e.target.value)} aria-label="Source table" disabled={!copyId}>
              <option value="">— source table —</option>
              {(live[copyId]?.model?.schemas ?? []).flatMap((s) => s.tables.map((t) => <option key={tableKey(s.name, t.name)} value={tableKey(s.name, t.name)}>{s.name ? `${s.name}.` : ''}{t.name}</option>))}
            </select>
            <button type="button" onClick={() => void loadCopy()} disabled={busy || !copyId || !copyKey}><Icon id="cloud-download" /> Load</button>
          </div>
          {source && (
            <div className="import-file">
              <Icon id={source.kind === 'sql' ? 'file-code' : 'table'} />
              <span>{source.name}</span>
              {source.sheets && source.sheets.length > 1 && (
                <select value={source.sheet} onChange={(e) => chooseSheet(e.target.value)} aria-label="Worksheet">
                  {source.sheets.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                </select>
              )}
              {source.kind === 'data' && <span className="hint">{source.data!.rows.length.toLocaleString()} rows · {source.data!.headers.length} columns</span>}
              {source.kind === 'sql' && <span className="hint">{summarizeScript(source.sql ?? '').statements} statements</span>}
            </div>
          )}
          {copyNote && <p className="hint"><Icon id="info" /> {copyNote}</p>}
        </div>

        {source?.kind === 'data' && info && (
          <div className="import-map">
            <div className="import-map-head"><span>Target column</span><span>Source column</span><span>Type</span></div>
            {info.columns.map((c) => (
              <div className="import-map-row" key={c.name}>
                <span title={c.default != null ? `Default: ${c.default}` : undefined}>{c.name}{!c.nullable && <b className="req"> *</b>}</span>
                <select value={mapping[c.name] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [c.name]: e.target.value }))}>
                  <option value="">— skip —</option>
                  {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
                <span className="hint">{c.dataType}</span>
              </div>
            ))}
            {missingRequired.length > 0 && <p className="hint error"><Icon id="triangle-alert" /> Unmapped required columns: {missingRequired.map((c) => c.name).join(', ')}</p>}
          </div>
        )}

        {showSql && statements.length > 0 && <pre className="import-sql" aria-label="Import SQL preview">{statements[0]}{statements.length > 1 ? `\n\n… ${statements.length - 1} more statement(s)` : ''}</pre>}
        {error && <p className="hint error"><Icon id="triangle-alert" /> {error}</p>}
        {done && <p className="hint ok"><Icon id="pass-filled" /> {done}</p>}

        <footer>
          <span className="hint">{source?.kind === 'data' && info ? `${rows.length.toLocaleString()} row(s) mapped` : ''}</span>
          <span className="grow" />
          <button type="button" disabled={!statements.length} onClick={() => setShowSql((v) => !v)}><Icon id="code" /> Preview SQL</button>
          <button type="button" onClick={close}>Close</button>
          <button className="primary" type="button" disabled={!canRun || busy} onClick={() => void execute()}>
            <Icon id={busy ? 'loading' : 'play'} className={busy ? 'codicon-modifier-spin' : undefined} /> {busy ? 'Importing…' : 'Import'}
          </button>
        </footer>
      </section>
    </div>
  )
}
