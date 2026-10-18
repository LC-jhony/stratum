import type { ErdOptions } from '../../erd/erd'
import { uid } from '../internal'
import type { ConsoleTab, DiagramTab, TableTab, TabsSlice, WorkbenchSlice } from '../types'

export const createTabsSlice: WorkbenchSlice<TabsSlice> = (set, get) => ({
  tabs: [],

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

  openDiagram(connectionId, options: ErdOptions = {}) {
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

  patchTab: (id, patch) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as typeof t) : t)) })),
})
