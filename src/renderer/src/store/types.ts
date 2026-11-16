import type { StateCreator } from 'zustand'
import type { StratumSettings } from '../../../core/settings'
import type { WorkspaceSnapshot } from '../../../core/workspace'
import type { ConnectionConfig, ConnectionView, DatabaseModel, ErdOptions, QueryPlan, QueryResult, SessionStateChange, TransactionState } from '../../../shared/types'
import type { UpdateState } from '../../../shared/update'

export interface ResultEntry {
  id: string
  title: string
  result: QueryResult
  /** Failure of an incremental page fetch; loaded rows are kept. */
  fetchError?: string
}

interface TabBase { id: string; title: string; connectionId: string }
export interface ConsoleTab extends TabBase {
  type: 'console'
  sql: string
  results: ResultEntry[]
  activeResult: number
  running: boolean
  /** File the script came from or was last saved to; relative `@include` resolves next to it. */
  path?: string
  /** Unsaved edits since the last open/save. */
  dirty?: boolean
  /** Last EXPLAIN for this tab. */
  plan?: QueryPlan
  planning?: boolean
}
export interface TableTab extends TabBase { type: 'table'; schema?: string; table: string }
export interface DiagramTab extends TabBase { type: 'diagram'; options: ErdOptions }
/** DataGrip's "New Table" designer; the table is created when Run is pressed. */
export interface DesignerTab extends TabBase { type: 'designer'; schema?: string }
export type Tab = ConsoleTab | TableTab | DiagramTab | DesignerTab

export interface Live {
  status: 'connecting' | 'ready' | 'error'
  version?: string
  model?: DatabaseModel
  error?: string
  loadingModel?: boolean
}

export interface ParamRequest {
  tabId: string
  params: { name: string; raw: string }[]
  values: Record<string, string>
}

export interface ConnectionsSlice {
  connections: ConnectionView[]
  live: Record<string, Live>
  load(): Promise<void>
  saveConnection(c: ConnectionConfig): Promise<void>
  removeConnection(id: string): Promise<void>
  connect(id: string): Promise<void>
  /** Close and re-open with the stored settings (applies edits and init SQL). */
  reconnect(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  refresh(id: string): Promise<void>
  /** A main-process session change (idle close, lost socket). */
  sessionState(state: SessionStateChange): void
}

export interface TabsSlice {
  tabs: Tab[]
  activeTab?: string
  openConsole(connectionId?: string, sql?: string): string | undefined
  openTable(connectionId: string, table: string, schema?: string): void
  openDiagram(connectionId: string, options?: ErdOptions): void
  openDesigner(connectionId: string, schema?: string): void
  closeTab(id: string): void
  setActive(id: string): void
  patchTab(id: string, patch: Partial<Tab>): void
  /** Reopen SQL consoles saved by the previous session (validated against the current connections). */
  restoreWorkspace(snapshot: WorkspaceSnapshot): void
}

export interface ScriptsSlice {
  /** Open a .sql file from disk in a console bound to the active (or first) data source. */
  openScript(): Promise<void>
  /** Save a console to its file; `saveAs` always asks for a path. Returns false when cancelled. */
  saveScript(tabId: string, saveAs?: boolean): Promise<boolean>
}

export interface ConsoleSlice {
  /** Executed statements per connection, newest first. */
  history: Record<string, string[]>
  /** Live transaction state per connection (toolbar and status). */
  transactions: Record<string, TransactionState>
  paramRequest?: ParamRequest
  run(tabId: string, statements: string[]): Promise<void>
  cancel(tabId: string): Promise<void>
  fetchMore(tabId: string, index: number): Promise<void>
  fetchAll(tabId: string, index: number): Promise<void>
  respondParams(values: Record<string, string> | null): void
  refreshTransaction(connectionId: string): Promise<void>
  beginTransaction(connectionId: string): Promise<void>
  commitTransaction(connectionId: string): Promise<void>
  rollbackTransaction(connectionId: string): Promise<void>
  savepoint(connectionId: string, name: string): Promise<void>
  rollbackToSavepoint(connectionId: string, name: string): Promise<void>
  releaseSavepoint(connectionId: string, name: string): Promise<void>
  /** Ask the database for the plan of one statement; keeps errors inside the plan. */
  plan(tabId: string, sql: string): Promise<void>
}

export interface PrefsSlice {
  prefs: StratumSettings
  /** True once load() finished; effects that reconcile theme/fonts with persisted prefs wait for it. */
  prefsLoaded: boolean
  settingsOpen: boolean
  openSettings(): void
  closeSettings(): void
  savePrefs(patch: Partial<StratumSettings>): Promise<void>
  /** Local-only settings preview while a dialog is open (no disk write); Cancel restores, OK calls savePrefs. */
  previewPrefs(patch: Partial<StratumSettings>): void
}

/** Where a CSV/SQL import should land; `table` is preset when the dialog opens from a table node. */
export interface ImportRequest { connectionId: string; schema?: string; table?: string }

export interface UiSlice {
  dialog?: { editing?: ConnectionView } | null
  importRequest?: ImportRequest
  palette?: null | 'actions' | 'colorTheme' | 'fileIconTheme' | 'productIconTheme'
  showResults: boolean
  objectSearchOpen: boolean
  libraryOpen: boolean
  extensionsOpen: boolean
  driverManagerOpen: boolean
  /** Connection whose server sessions/locks are being inspected. */
  sessionMonitor?: string
  set(p: Partial<Pick<WorkbenchState, 'dialog' | 'importRequest' | 'palette' | 'showResults' | 'objectSearchOpen' | 'libraryOpen' | 'extensionsOpen' | 'driverManagerOpen' | 'sessionMonitor'>>): void
}

export interface UpdateSlice {
  /** Latest snapshot pushed by the main process. */
  update?: UpdateState
  /** The status-bar popover is open. */
  updatesOpen: boolean
  initUpdates(): Promise<() => void>
  showUpdates(): void
  hideUpdates(): void
  checkUpdates(open?: boolean): Promise<void>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
}

export type WorkbenchState = ConnectionsSlice & TabsSlice & ScriptsSlice & ConsoleSlice & PrefsSlice & UiSlice & UpdateSlice
export type WorkbenchSlice<T> = StateCreator<WorkbenchState, [], [], T>
