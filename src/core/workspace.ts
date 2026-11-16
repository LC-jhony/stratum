/**
 * Workspace restore: the tiny, versioned snapshot of open SQL consoles that survives a restart.
 *
 * Only console text is persisted — never result sets, live sessions or secrets. The snapshot is
 * validated again on restore so an edited/hostile localStorage value cannot exceed the caps or
 * resurrect a connection that was deleted.
 */
export interface WorkspaceTabInput {
  id: string
  title: string
  connectionId: string
  sql: string
  /** File the console was opened from, so relative `@include` keeps working after a restart. */
  path?: string
}

export interface WorkspaceTab {
  id: string
  title: string
  connectionId: string
  sql: string
  path?: string
}

export interface WorkspaceSnapshot {
  version: 1
  tabs: WorkspaceTab[]
  activeTab?: string
}

export const WORKSPACE_STORAGE_KEY = 'stratum.workspace.v1'
export const WORKSPACE_VERSION = 1 as const
export const WORKSPACE_MAX_TABS = 30
export const WORKSPACE_MAX_TAB_SQL = 1_000_000
export const WORKSPACE_MAX_TOTAL_SQL = 4_000_000

const clean = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')

/**
 * Build the JSON written to localStorage. Returns `undefined` when there is nothing worth saving,
 * so the caller can remove the stale key instead of storing an empty workspace.
 */
export function serializeWorkspace(tabs: readonly WorkspaceTabInput[], activeTab?: string): string | undefined {
  const kept: WorkspaceTab[] = []
  let total = 0
  for (const tab of tabs) {
    if (kept.length >= WORKSPACE_MAX_TABS) break
    const sql = typeof tab.sql === 'string' ? tab.sql : ''
    if (!sql.trim()) continue
    if (total + sql.length > WORKSPACE_MAX_TOTAL_SQL) continue
    total += sql.length
    const file = clean(tab.path, 4000)
    kept.push({
      id: clean(tab.id, 200),
      title: clean(tab.title, 200),
      connectionId: clean(tab.connectionId, 200),
      sql: sql.slice(0, WORKSPACE_MAX_TAB_SQL),
      ...(file ? { path: file } : {}),
    })
  }
  if (!kept.length) return undefined
  const selected = activeTab && kept.some((tab) => tab.id === activeTab) ? activeTab : undefined
  return JSON.stringify({ version: WORKSPACE_VERSION, tabs: kept, activeTab: selected } satisfies WorkspaceSnapshot)
}

/** Parse and validate a stored snapshot. Invalid JSON, unknown versions and deleted connections are ignored. */
export function parseWorkspace(raw: string | null | undefined, connectionIds: readonly string[]): WorkspaceSnapshot | undefined {
  if (!raw) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return undefined }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const value = parsed as { version?: unknown; tabs?: unknown; activeTab?: unknown }
  if (value.version !== WORKSPACE_VERSION || !Array.isArray(value.tabs)) return undefined
  const validConnections = new Set(connectionIds)
  const tabs: WorkspaceTab[] = []
  let total = 0
  for (const item of value.tabs) {
    if (tabs.length >= WORKSPACE_MAX_TABS) break
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const tab = item as Record<string, unknown>
    const id = clean(tab.id, 200)
    const title = clean(tab.title, 200)
    const connectionId = clean(tab.connectionId, 200)
    const sql = clean(tab.sql, WORKSPACE_MAX_TAB_SQL)
    if (!id || !connectionId || !validConnections.has(connectionId) || !sql.trim()) continue
    if (total + sql.length > WORKSPACE_MAX_TOTAL_SQL) continue
    total += sql.length
    const file = clean(tab.path, 4000)
    tabs.push({ id, title: title || 'SQL console', connectionId, sql, ...(file ? { path: file } : {}) })
  }
  if (!tabs.length) return undefined
  const activeTab = typeof value.activeTab === 'string' && tabs.some((tab) => tab.id === value.activeTab) ? value.activeTab : undefined
  return { version: WORKSPACE_VERSION, tabs, activeTab }
}
