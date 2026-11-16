import { ipc } from '../../ipc/client'
import { uid } from '../internal'
import type { ConsoleTab, ScriptsSlice, WorkbenchSlice } from '../types'

const SQL_FILTERS = [{ name: 'SQL scripts', extensions: ['sql', 'ddl', 'pgsql', 'mysql', 'sqlite'] }]

const baseName = (path: string): string => path.split(/[\\/]/).pop() || path
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** File-backed consoles: open a script from disk, save it back, and remember its path for @include. */
export const createScriptsSlice: WorkbenchSlice<ScriptsSlice> = (set, get) => ({
  async openScript() {
    let file: { path: string; name: string; content: string } | null
    try {
      file = await ipc.dialogs.openText(SQL_FILTERS)
    } catch (e) {
      window.alert(errorText(e))
      return
    }
    if (!file) return
    const active = get().tabs.find((t) => t.id === get().activeTab)
    const connectionId = active?.connectionId ?? get().connections[0]?.id
    if (!connectionId) { window.alert('Create a data source before opening a SQL script.'); return }
    void get().connect(connectionId)
    // Reuse a pristine untitled console instead of leaving empty tabs behind.
    const pristine = active?.type === 'console' && !active.path && !active.sql.trim() ? active : undefined
    const tab: ConsoleTab = {
      id: pristine?.id ?? uid('console'), type: 'console', connectionId,
      title: file.name, sql: file.content, path: file.path, dirty: false,
      results: [], activeResult: 0, running: false,
    }
    set((s) => ({ tabs: pristine ? s.tabs.map((t) => (t.id === pristine.id ? tab : t)) : [...s.tabs, tab], activeTab: tab.id }))
  },

  async saveScript(tabId, saveAs = false) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (tab?.type !== 'console') return false
    const defaultName = tab.path ? baseName(tab.path) : `${tab.title.replace(/[\\/:*?"<>|]+/g, '-') || 'query'}.sql`
    try {
      const saved = await ipc.script.write(saveAs ? undefined : tab.path, tab.sql, defaultName)
      if (!saved) return false
      get().patchTab(tabId, { path: saved, title: baseName(saved), dirty: false } as Partial<ConsoleTab>)
      return true
    } catch (e) {
      window.alert(errorText(e))
      return false
    }
  },
})
