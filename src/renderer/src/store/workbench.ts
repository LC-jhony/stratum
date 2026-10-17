import { create } from 'zustand'
import { DEFAULT_SETTINGS, mergeSettings, type StratumSettings } from '../../../shared/settings'
import { connectionDialect } from '../../../shared/dialects'
import { findParams, substituteParams } from '../../../shared/sqlParams'
import type { ConnectionConfig, DatabaseModel, QueryResult } from '../../../shared/types'
import type { ErdOptions } from '../erd/erd'

export interface ResultEntry { id: string; title: string; result: QueryResult }
interface TabBase { id: string; title: string; connectionId: string }
export interface ConsoleTab extends TabBase { type: 'console'; sql: string; results: ResultEntry[]; activeResult: number; running: boolean }
export interface TableTab extends TabBase { type: 'table'; schema?: string; table: string }
export interface DiagramTab extends TabBase { type: 'diagram'; options: ErdOptions }
export type Tab = ConsoleTab | TableTab | DiagramTab

export interface Live { status: 'connecting' | 'ready' | 'error'; version?: string; model?: DatabaseModel; error?: string; loadingModel?: boolean }
let seq = 0
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${seq++}`
/** Pending SQL-parameter prompt resolver, set while ParamDialog is open. */
let paramResolver: ((values: Record<string, string> | null) => void) | null = null

interface State {
  connections: ConnectionConfig[]
  live: Record<string, Live>
  tabs: Tab[]
  activeTab?: string
  dialog?: { editing?: ConnectionConfig } | null
  palette?: null | 'actions' | 'colorTheme' | 'fileIconTheme' | 'productIconTheme'
  showResults: boolean
  prefs: StratumSettings
  /** True once load() finished; effects that reconcile theme/fonts with persisted prefs wait for it. */
  prefsLoaded: boolean
  settingsOpen: boolean
  /** Open SQL-parameter prompt (DataGrip-style); resolved by ParamDialog. */
  paramRequest?: { tabId: string; params: { name: string; raw: string }[]; values: Record<string, string> }
  load(): Promise<void>
  openSettings(): void
  closeSettings(): void
  savePrefs(patch: Partial<StratumSettings>): Promise<void>
  /** Local-only settings preview while a dialog is open (no disk write); Cancel restores, OK calls savePrefs. */
  previewPrefs(patch: Partial<StratumSettings>): void
  saveConnection(c: ConnectionConfig): Promise<void>
  removeConnection(id: string): Promise<void>
  connect(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  refresh(id: string): Promise<void>
  openConsole(connectionId?: string, sql?: string): string | undefined
  openTable(connectionId: string, table: string, schema?: string): void
  openDiagram(connectionId: string, options?: ErdOptions): void
  closeTab(id: string): void
  setActive(id: string): void
  patchTab(id: string, patch: Partial<Tab>): void
  run(tabId: string, statements: string[]): Promise<void>
  cancel(tabId: string): Promise<void>
  /** Close the parameter prompt: values to substitute, or null to abort the run. */
  respondParams(values: Record<string, string> | null): void
  set(p: Partial<Pick<State, 'dialog' | 'palette' | 'showResults'>>): void
}

export const useWorkbench = create<State>((set, get) => ({
  connections: [], live: {}, tabs: [], showResults: true, prefs: DEFAULT_SETTINGS, prefsLoaded: false, settingsOpen: false,
  async load() {
    const [connections, raw] = await Promise.all([window.stratum.connections.list(), window.stratum.settings.get()])
    set({ connections, prefs: mergeSettings(raw), prefsLoaded: true })
  },
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  async savePrefs(patch) {
    const prefs = mergeSettings({ ...get().prefs, ...patch } as Record<string, unknown>)
    set({ prefs })
    await window.stratum.settings.set(patch as Record<string, unknown>)
  },
  previewPrefs: (patch) => set((s) => ({ prefs: mergeSettings({ ...s.prefs, ...patch } as Record<string, unknown>) })),
  async saveConnection(c) {
    await window.stratum.connections.save(c)
    set((s) => ({ live: Object.fromEntries(Object.entries(s.live).filter(([k]) => k !== c.id)) }))
    await get().load()
  },
  async removeConnection(id) {
    await window.stratum.connections.remove(id)
    set((s) => ({ tabs: s.tabs.filter((t) => t.connectionId !== id) }))
    await get().load()
  },
  async connect(id) {
    if (get().live[id]?.status === 'ready' || get().live[id]?.status === 'connecting') return
    set((s) => ({ live: { ...s.live, [id]: { status: 'connecting' } } }))
    try {
      const { version } = await window.stratum.connections.open(id)
      set((s) => ({ live: { ...s.live, [id]: { status: 'ready', version, loadingModel: true } } }))
      await get().refresh(id)
    } catch (e) { set((s) => ({ live: { ...s.live, [id]: { status: 'error', error: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e) } } })) }
  },
  async disconnect(id) {
    await window.stratum.connections.close(id)
    set((s) => { const live = { ...s.live }; delete live[id]; return { live } })
  },
  async refresh(id) {
    set((s) => ({ live: { ...s.live, [id]: { ...s.live[id], status: 'ready', loadingModel: true } } }))
    try { const model = await window.stratum.db.introspect(id); set((s) => ({ live: { ...s.live, [id]: { ...s.live[id], model, loadingModel: false } } })) }
    catch (e) { set((s) => ({ live: { ...s.live, [id]: { ...s.live[id], loadingModel: false, error: String(e) } } })) }
  },
  openConsole(connectionId, sql = '') {
    const cid = connectionId ?? get().tabs.find((t) => t.id === get().activeTab)?.connectionId ?? get().connections[0]?.id
    if (!cid) return void get().set({ dialog: {} })
    void get().connect(cid)
    const n = get().tabs.filter((t) => t.type === 'console' && t.connectionId === cid).length
    const name = get().connections.find((c) => c.id === cid)?.name ?? 'console'
    const tab: ConsoleTab = { id: uid('console'), type: 'console', connectionId: cid, title: n ? `${name} [${n + 1}]` : `${name} console`, sql, results: [], activeResult: 0, running: false }
    set((s) => ({ tabs: [...s.tabs, tab], activeTab: tab.id }))
    return tab.id
  },
  openTable(connectionId, table, schema) {
    const ex = get().tabs.find((t) => t.type === 'table' && t.connectionId === connectionId && t.table === table && t.schema === schema)
    if (ex) return set({ activeTab: ex.id })
    const tab: TableTab = { id: uid('table'), type: 'table', connectionId, table, schema, title: table }
    set((s) => ({ tabs: [...s.tabs, tab], activeTab: tab.id }))
  },
  openDiagram(connectionId, options = {}) {
    const name = options.focus?.table ?? get().connections.find((c) => c.id === connectionId)?.name ?? 'schema'
    const tab: DiagramTab = { id: uid('erd'), type: 'diagram', connectionId, options, title: `${name} diagram` }
    set((s) => ({ tabs: [...s.tabs, tab], activeTab: tab.id }))
  },
  closeTab(id) {
    set((s) => {
      const i = s.tabs.findIndex((t) => t.id === id), tabs = s.tabs.filter((t) => t.id !== id)
      return { tabs, activeTab: s.activeTab === id ? tabs[Math.min(i, tabs.length - 1)]?.id : s.activeTab }
    })
  },
  setActive: (id) => set({ activeTab: id }),
  patchTab: (id, patch) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)) })),
  async run(tabId, statements) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (tab?.type !== 'console' || !statements.length) return
    await get().connect(tab.connectionId)
    get().patchTab(tabId, { running: true })
    const prefs = get().prefs
    const conn = get().connections.find((c) => c.id === tab.connectionId)
    const dialect = connectionDialect(conn, get().live[tab.connectionId]?.model)
    const results: ResultEntry[] = []
    let aborted = false
    for (const statement of statements) {
      let sql = statement
      if (prefs['query.parameters.enabled']) {
        const params = findParams(sql, dialect)
        if (params.length) {
          const unique = [...new Map(params.map((p) => [p.name, p])).values()].map((p) => ({ name: p.name, raw: p.raw }))
          const remembered = { ...prefs['query.parameters.values'] }
          const values = await new Promise<Record<string, string> | null>((resolve) => {
            paramResolver = resolve
            set({ paramRequest: { tabId, params: unique, values: remembered } })
          })
          set({ paramRequest: undefined }); paramResolver = null
          if (!values) { aborted = true; break }
          sql = substituteParams(sql, params, values)
          void get().savePrefs({ 'query.parameters.values': { ...remembered, ...values } })
        }
      }
      if (prefs['query.confirmDestructive'] && /^\s*(update|delete)\b/i.test(sql) && !/\bwhere\b/i.test(sql)) {
        if (!window.confirm(`Run this statement without WHERE?\n\n${sql.replace(/\s+/g, ' ').slice(0, 200)}`)) continue
      }
      const result = await window.stratum.db.execute(tab.connectionId, sql, { limit: prefs['query.pageSize'] })
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
  respondParams: (values) => paramResolver?.(values),
  async cancel(tabId) { const t = get().tabs.find((x) => x.id === tabId); if (t) await window.stratum.db.cancel(t.connectionId) },
  set: (p) => set(p),
}))
