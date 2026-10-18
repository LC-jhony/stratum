import type { StateCreator } from 'zustand'
import type { StratumSettings } from '../../../core/settings'
import type { ConnectionConfig, ConnectionView, DatabaseModel, QueryResult } from '../../../shared/types'
import type { ErdOptions } from '../erd/erd'

export interface ResultEntry {
  id: string
  title: string
  result: QueryResult
  /** Failure of an incremental page fetch; loaded rows are kept. */
  fetchError?: string
}

interface TabBase { id: string; title: string; connectionId: string }
export interface ConsoleTab extends TabBase { type: 'console'; sql: string; results: ResultEntry[]; activeResult: number; running: boolean }
export interface TableTab extends TabBase { type: 'table'; schema?: string; table: string }
export interface DiagramTab extends TabBase { type: 'diagram'; options: ErdOptions }
export type Tab = ConsoleTab | TableTab | DiagramTab

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
  disconnect(id: string): Promise<void>
  refresh(id: string): Promise<void>
}

export interface TabsSlice {
  tabs: Tab[]
  activeTab?: string
  openConsole(connectionId?: string, sql?: string): string | undefined
  openTable(connectionId: string, table: string, schema?: string): void
  openDiagram(connectionId: string, options?: ErdOptions): void
  closeTab(id: string): void
  setActive(id: string): void
  patchTab(id: string, patch: Partial<Tab>): void
}

export interface ConsoleSlice {
  paramRequest?: ParamRequest
  run(tabId: string, statements: string[]): Promise<void>
  cancel(tabId: string): Promise<void>
  fetchMore(tabId: string, index: number): Promise<void>
  fetchAll(tabId: string, index: number): Promise<void>
  respondParams(values: Record<string, string> | null): void
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

export interface UiSlice {
  dialog?: { editing?: ConnectionView } | null
  palette?: null | 'actions' | 'colorTheme' | 'fileIconTheme' | 'productIconTheme'
  showResults: boolean
  set(p: Partial<Pick<WorkbenchState, 'dialog' | 'palette' | 'showResults'>>): void
}

export type WorkbenchState = ConnectionsSlice & TabsSlice & ConsoleSlice & PrefsSlice & UiSlice
export type WorkbenchSlice<T> = StateCreator<WorkbenchState, [], [], T>
