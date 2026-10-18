import { ipc } from '../../ipc/client'
import { connectionDialect } from '../../../../core/dialects'
import { isSqlKind } from '../../../../core/kinds'
import { findParams, substituteParams } from '../../../../core/sqlParams'
import { fetchStop, holdParams, releaseParams, resolveParams, uid } from '../internal'
import type { ConsoleSlice, ResultEntry, WorkbenchSlice } from '../types'

export const createConsoleSlice: WorkbenchSlice<ConsoleSlice> = (set, get) => ({
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
    const results: ResultEntry[] = []
    let aborted = false
    for (const statement of statements) {
      let sql = statement
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
          if (!values) { aborted = true; break }
          sql = substituteParams(sql, params, values)
          void get().savePrefs({ 'query.parameters.values': { ...remembered, ...values } })
        }
      }
      if (sqlKind && prefs['query.confirmDestructive'] && /^\s*(update|delete)\b/i.test(sql) && !/\bwhere\b/i.test(sql)) {
        if (!window.confirm(`Run this statement without WHERE?\n\n${sql.replace(/\s+/g, ' ').slice(0, 200)}`)) continue
      }
      const result = await ipc.db.execute(tab.connectionId, sql, { limit: prefs['query.pageSize'] })
      results.push({ id: uid('r'), title: sql.replace(/\s+/g, ' ').slice(0, 40), result })
      if (result.error) break
    }
    get().patchTab(tabId, { running: false, results, activeResult: results.length - 1 })
    set({ showResults: true })
    if (!aborted && results.length) { // DataGrip-style console history, newest first, per connection.
      const history = { ...get().prefs['query.history'] }
      history[tab.connectionId] = [...new Set([...statements, ...(history[tab.connectionId] ?? [])])].slice(0, 100)
      void get().savePrefs({ 'query.history': history })
    }
    if (results.some((r) => /^\s*(create|alter|drop|rename)\b/i.test(r.result.sql) && !r.result.error)) void get().refresh(tab.connectionId)
  },

  respondParams: (values) => resolveParams(values),

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
