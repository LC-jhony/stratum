import { ipc } from '../../ipc/client'
import { connectionDialect } from '../../../../core/dialects'
import { EXPORT_FORMATS, exportText } from '../../../../core/export'
import { collectRows } from '../../../../core/exportBudget'
import { isSqlKind } from '../../../../core/kinds'
import { confirmsWrites, writeKind, writeLabel } from '../../../../core/profiles'
import { parseScript, type ScriptItem } from '../../../../core/script'
import { applyVariables, findParams, substituteParams } from '../../../../core/sqlParams'
import { bytesToBase64, exportXlsx } from '../../../../core/xlsx'
import { fetchStop, holdParams, releaseParams, resolveParams, uid } from '../internal'
import type { ConsoleSlice, ResultEntry, WorkbenchSlice } from '../types'
import type { QueryResult } from '../../../../shared/types'

const cleanIpcError = (e: unknown) => e instanceof Error
  ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  : String(e)

/** An include chain deeper than this is almost certainly a mistake, not a real script hierarchy. */
const MAX_SCRIPT_DEPTH = 10
/** Total files pulled in by one run; keeps a pathological script from reading forever. */
const MAX_SCRIPT_INCLUDES = 50

export const createConsoleSlice: WorkbenchSlice<ConsoleSlice> = (set, get) => ({
  history: {},
  transactions: {},
  async run(tabId, statements) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (tab?.type !== 'console' || !statements.length) return
    fetchStop.delete(tabId)
    await get().connect(tab.connectionId)
    get().patchTab(tabId, { running: true })
    const prefs = get().prefs
    const conn = get().connections.find((c) => c.id === tab.connectionId)
    const dialect = connectionDialect(conn, get().live[tab.connectionId]?.model)
    const sqlKind = isSqlKind(conn?.kind)
    /** Script variables: `@set` layers on top of the connection + global values for this run only. */
    const variables = { ...(prefs['variables.global'] ?? {}), ...(conn?.variables ?? {}) }
    const results: ResultEntry[] = []
    let aborted = false, stopped = false
    let lastResult: QueryResult | undefined
    const included = new Set<string>()
    let includeCount = 0

    const push = (sql: string, result: QueryResult) => {
      results.push({ id: uid('r'), title: sql.replace(/\s+/g, ' ').slice(0, 40), result })
    }
    const fail = (sql: string, message: string) => {
      push(sql, { sql, columns: [], rows: [], durationMs: 0, offset: 0, hasMore: false, error: message })
      stopped = true
    }

    const executeSql = async (sqlText: string) => {
      let sql = applyVariables(sqlText, variables)
      if (sqlKind && prefs['query.parameters.enabled']) {
        const params = findParams(sql, dialect)
        if (params.length) {
          const unique = [...new Map(params.map((p) => [p.name, p])).values()].map((p) => ({ name: p.name, raw: p.raw }))
          const remembered = { ...prefs['query.parameters.values'] }
          const values = await new Promise<Record<string, string> | null>((resolve) => {
            holdParams(resolve)
            set({ paramRequest: { tabId, params: unique, values: remembered } })
          })
          set({ paramRequest: undefined })
          releaseParams()
          if (!values) { aborted = true; stopped = true; return }
          sql = substituteParams(sql, params, values)
          void get().savePrefs({ 'query.parameters.values': { ...remembered, ...values } })
        }
      }
      if (sqlKind && prefs['query.confirmDestructive'] && /^\s*(update|delete)\b/i.test(sql) && !/\bwhere\b/i.test(sql)) {
        if (!window.confirm(`Run this statement without WHERE?\n\n${sql.replace(/\s+/g, ' ').slice(0, 200)}`)) return
      } else if (sqlKind) {
        const kind = writeKind(sql)
        if (kind && confirmsWrites(conn)) {
          const label = writeLabel(kind)
          if (!window.confirm(`${conn?.name ?? 'This data source'} is protected: run this ${label}?\n\n${sql.replace(/\s+/g, ' ').slice(0, 300)}`)) return
        }
      }
      const result = await ipc.db.execute(tab.connectionId, sql, { limit: prefs['query.pageSize'] })
        .catch((e: unknown) => ({ sql, columns: [], rows: [], durationMs: 0, offset: 0, hasMore: false, error: cleanIpcError(e) }))
      push(sql, result)
      if (result.error) { stopped = true; return }
      lastResult = result
    }

    /** `@export` writes the previous result (or the grid's last one) through a native save dialog. */
    const exportResult = async (item: Extract<ScriptItem, { type: 'export' }>) => {
      const previous = lastResult ?? (() => {
        const t = get().tabs.find((x) => x.id === tabId)
        return t?.type === 'console' ? [...t.results].reverse().find((e) => !e.result.error)?.result : undefined
      })()
      if (!previous) return fail(`@export ${item.path}`, 'There is no query result to export. Run a query before @export.')
      try {
        const data = await collectRows({
          head: previous.rows,
          offset: previous.offset,
          hasMore: previous.hasMore,
          fetchPage: async (offset, limit) => {
            const page = await ipc.db.execute(tab.connectionId, previous.sql, { limit, offset, full: true })
            return { rows: page.rows, hasMore: page.hasMore, error: page.error }
          },
        })
        const spec = EXPORT_FORMATS.find((f) => f.id === item.format)!
        const requestedExt = item.path.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase()
        const filters = [{ name: spec.label, extensions: [...new Set([spec.ext, requestedExt].filter((x): x is string => !!x))] }]
        let saved: string | null
        if (item.format === 'xlsx') {
          saved = await ipc.export.saveBinary(item.path, bytesToBase64(exportXlsx(previous.columns, data, 'result')), filters)
        } else {
          const text = exportText(previous.columns, data, item.format, 'result', dialect, { neutralizeFormulas: prefs['export.neutralizeFormulas'] })
          saved = await ipc.export.save(item.path, text, filters)
        }
        if (saved) {
          push(`@export ${item.path}`, {
            sql: `@export ${item.path}`, columns: [{ name: 'file' }, { name: 'rows' }], rows: [[saved, data.length]],
            durationMs: 0, offset: 0, hasMore: false,
          })
        }
      } catch (e) {
        fail(`@export ${item.path}`, cleanIpcError(e))
      }
    }

    const runItems = async (items: ScriptItem[], from: string | undefined, depth: number): Promise<void> => {
      for (const item of items) {
        if (stopped || aborted) return
        if (item.type === 'sql') { await executeSql(item.text); continue }
        if (item.type === 'set') { variables[item.name] = applyVariables(item.value, variables); continue }
        if (item.type === 'include') {
          if (depth >= MAX_SCRIPT_DEPTH) return fail(`@include ${item.path}`, `Includes are nested more than ${MAX_SCRIPT_DEPTH} levels deep.`)
          if (++includeCount > MAX_SCRIPT_INCLUDES) return fail(`@include ${item.path}`, `This script includes more than ${MAX_SCRIPT_INCLUDES} files.`)
          const requested = applyVariables(item.path, variables)
          let file: { path: string; content: string }
          try { file = await ipc.script.read(requested, from) }
          catch (e) { return fail(`@include ${requested}`, cleanIpcError(e)) }
          if (included.has(file.path)) return fail(`@include ${file.path}`, `Circular @include: ${file.path} is already being executed.`)
          included.add(file.path)
          try {
            let nested: ScriptItem[]
            try { nested = parseScript(file.content) }
            catch (e) { return fail(`@include ${file.path}`, `${file.path}: ${cleanIpcError(e)}`) }
            await runItems(nested, file.path, depth + 1)
          } finally {
            included.delete(file.path)
          }
          continue
        }
        await exportResult(item)
      }
    }

    try {
      for (const chunk of statements) {
        let items: ScriptItem[]
        try { items = parseScript(chunk) }
        catch (e) { fail(chunk, cleanIpcError(e)); break }
        await runItems(items, undefined, 0)
        if (stopped || aborted) break
      }
    } catch (e) {
      fail(statements.join(' '), cleanIpcError(e))
    }

    get().patchTab(tabId, { running: false, results, activeResult: results.length - 1 })
    set({ showResults: true })
    void get().refreshTransaction(tab.connectionId)
    if (!aborted && results.length) { // DataGrip-style console history, newest first, per connection.
      set((s) => ({ history: { ...s.history, [tab.connectionId]: [...new Set([...statements, ...(s.history[tab.connectionId] ?? [])])].slice(0, 100) } }))
      void ipc.history.add(tab.connectionId, statements)
    }
    if (results.some((r) => /^\s*(create|alter|drop|rename)\b/i.test(r.result.sql) && !r.result.error)) void get().refresh(tab.connectionId)
  },

  respondParams: (values) => resolveParams(values),

  async refreshTransaction(connectionId) {
    try {
      const state = await ipc.db.transaction(connectionId)
      set((s) => ({ transactions: { ...s.transactions, [connectionId]: state } }))
    } catch { /* not connected: the toolbar keeps its last known state */ }
  },

  async beginTransaction(connectionId) {
    try {
      const state = await ipc.db.begin(connectionId)
      set((s) => ({ transactions: { ...s.transactions, [connectionId]: state } }))
    } catch (e) {
      window.alert(cleanIpcError(e))
    }
  },

  async commitTransaction(connectionId) {
    try {
      const state = await ipc.db.commit(connectionId)
      set((s) => ({ transactions: { ...s.transactions, [connectionId]: state } }))
    } catch (e) {
      window.alert(cleanIpcError(e))
    }
  },

  async rollbackTransaction(connectionId) {
    try {
      const state = await ipc.db.rollback(connectionId)
      set((s) => ({ transactions: { ...s.transactions, [connectionId]: state } }))
    } catch (e) {
      window.alert(cleanIpcError(e))
    }
  },

  async savepoint(connectionId, name) {
    try {
      const state = await ipc.db.savepoint(connectionId, name)
      set((s) => ({ transactions: { ...s.transactions, [connectionId]: state } }))
    } catch (e) {
      window.alert(cleanIpcError(e))
    }
  },

  async rollbackToSavepoint(connectionId, name) {
    try {
      const state = await ipc.db.rollbackToSavepoint(connectionId, name)
      set((s) => ({ transactions: { ...s.transactions, [connectionId]: state } }))
    } catch (e) {
      window.alert(cleanIpcError(e))
    }
  },

  async releaseSavepoint(connectionId, name) {
    try {
      const state = await ipc.db.releaseSavepoint(connectionId, name)
      set((s) => ({ transactions: { ...s.transactions, [connectionId]: state } }))
    } catch (e) {
      window.alert(cleanIpcError(e))
    }
  },

  async plan(tabId, sql) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (tab?.type !== 'console') return
    const conn = get().connections.find((c) => c.id === tab.connectionId)
    const dialect = connectionDialect(conn, get().live[tab.connectionId]?.model)
    const expanded = applyVariables(sql, { ...(get().prefs['variables.global'] ?? {}), ...(conn?.variables ?? {}) })
    get().patchTab(tabId, { planning: true })
    try {
      await get().connect(tab.connectionId)
      const plan = await ipc.db.plan(tab.connectionId, expanded)
      get().patchTab(tabId, { plan, planning: false })
    } catch (e) {
      get().patchTab(tabId, { plan: { dialect, format: 'text', sql: expanded, durationMs: 0, root: { label: 'Execution plan' }, error: cleanIpcError(e) }, planning: false })
    }
  },

  async fetchMore(tabId, index) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (tab?.type !== 'console' || tab.running) return
    const entry = tab.results[index], r = entry?.result
    if (!entry || !r || r.error || !r.hasMore) return
    const fail = (message: string) => set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId && t.type === 'console' ? { ...t, results: t.results.map((e, i) => (i === index ? { ...e, fetchError: message } : e)) } : t)),
    }))
    get().patchTab(tabId, { running: true })
    try {
      const page = await ipc.db.execute(tab.connectionId, r.sql, { limit: get().prefs['query.pageSize'], offset: r.offset + r.rows.length })
      const patch = (e: ResultEntry): ResultEntry => ({ ...e, fetchError: page.error, result: { ...r, rows: [...r.rows, ...page.rows], hasMore: page.hasMore, durationMs: r.durationMs + page.durationMs } })
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId && t.type === 'console' ? { ...t, results: t.results.map((e, i) => (i === index ? patch(e) : e)) } : t)) }))
    } catch (e) {
      fail(String(e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      get().patchTab(tabId, { running: false })
    }
  },

  async fetchAll(tabId, index) {
    fetchStop.delete(tabId)
    for (let page = 0; page < 50; page++) { // safety cap: 50 pages per click
      const tab = get().tabs.find((t) => t.id === tabId)
      const entry = tab?.type === 'console' ? tab.results[index] : undefined
      if (!entry || entry.result.error || !entry.result.hasMore || fetchStop.has(tabId)) return
      const before = entry.result.rows.length
      await get().fetchMore(tabId, index)
      const after = get().tabs.find((t) => t.id === tabId)
      const now = after?.type === 'console' ? after.results[index] : undefined
      if (!now || now.result.rows.length === before) return // error or no progress: stop instead of looping
    }
  },

  async cancel(tabId) {
    fetchStop.add(tabId)
    const t = get().tabs.find((x) => x.id === tabId)
    if (t) await ipc.db.cancel(t.connectionId)
  },
})
