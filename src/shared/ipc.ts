import type { AiChatResult, AiMessage } from './ai'
import type { DockerContainer, DockerEndpoint } from './docker'
import type { DriverJar } from './drivers'
import type { ExtensionView } from './extensions'
import type { ScheduledTask, TaskFormat, TaskInput } from './tasks'
import type {
  ConnectionConfig, ConnectionView, DatabaseModel, QueryPlan, QueryResult, SavedQuery, SessionInfo,
  SessionStateChange, ThemeFile, ThemeManifestEntry, TransactionState,
} from './types'
import type { UpdateState } from './update'

/** Native save-dialog filter (matches Electron's FileFilter). */
export interface SaveFilter { name: string; extensions: string[] }

/** Where a connection export went and how many data sources it contains. */
export interface ConnectionExportResult { path: string; count: number }
/** Imported data sources (safe metadata), the file they came from and entries that were repaired or skipped. */
export interface ConnectionImportResult { path: string; imported: ConnectionView[]; warnings: string[] }

/** Single typed contract between renderer and main. Every channel is request/response. */
export interface StratumApi {
  connections: {
    /** Metadata only: secrets stay in the main process. */
    list(): Promise<ConnectionView[]>
    /** Omit password / ssh password to keep the stored secret. */
    save(c: ConnectionConfig): Promise<void>
    remove(id: string): Promise<void>
    test(c: ConnectionConfig): Promise<{ ok: boolean; version?: string; error?: string }>
    open(id: string): Promise<{ version?: string }>
    close(id: string): Promise<void>
    /** Close and open again, applying edited settings, init SQL and a fresh tunnel. */
    reconnect(id: string): Promise<{ version?: string }>
    /** Save every data source as portable JSON. Passwords never leave the machine; null when cancelled. */
    exportFile(): Promise<ConnectionExportResult | null>
    /** Import portable JSON with fresh ids and non-colliding names; null when cancelled. */
    importFile(): Promise<ConnectionImportResult | null>
    /** Main -> renderer session loss (idle timeout or a broken keep-alive). Returns an unsubscribe function. */
    onState(cb: (state: SessionStateChange) => void): () => void
  }
  db: {
    introspect(id: string): Promise<DatabaseModel>
    execute(id: string, sql: string, opts?: { limit?: number; offset?: number; /** Fetch complete binary values (exports). */ full?: boolean }): Promise<QueryResult>
    cancel(id: string): Promise<void>
    /** Apply edits from the data grid (DataGrip "Submit"). Runs inside one transaction. */
    submit(id: string, statements: string[]): Promise<{ ok: boolean; error?: string }>
    /** Normalized execution plan for one statement (PostgreSQL/MySQL/SQLite JSON, textual fallback). */
    plan(id: string, sql: string): Promise<QueryPlan>
    transaction(id: string): Promise<TransactionState>
    begin(id: string): Promise<TransactionState>
    commit(id: string): Promise<TransactionState>
    rollback(id: string): Promise<TransactionState>
    /** Create a savepoint (opens the transaction first when auto-commit is on). */
    savepoint(id: string, name: string): Promise<TransactionState>
    /** Discard changes made after a savepoint; the savepoint remains usable. */
    rollbackToSavepoint(id: string, name: string): Promise<TransactionState>
    /** Release a savepoint explicitly (unsupported on SQL Server). */
    releaseSavepoint(id: string, name: string): Promise<TransactionState>
    /** Server sessions/locks (PostgreSQL, MySQL). */
    sessions(id: string): Promise<SessionInfo[]>
    killSession(id: string, pid: number | string): Promise<void>
  }
  library: {
    /** Named SQL statements, newest edit first. */
    list(): Promise<SavedQuery[]>
    /** Insert or update by id; `updatedAt` is stamped in main. */
    save(query: SavedQuery): Promise<void>
    remove(id: string): Promise<void>
  }
  extensions: {
    /** Installed manifests with their persisted enabled state. */
    list(): Promise<ExtensionView[]>
    /** Persist a toggle and return the updated list; mandatory extensions reject `false`. */
    setEnabled(id: string, enabled: boolean): Promise<ExtensionView[]>
  }
  drivers: {
    /** JARs managed inside <userData>/drivers. */
    list(): Promise<DriverJar[]>
    /** Copy one or more JARs chosen in a native dialog into the managed folder. */
    add(): Promise<DriverJar[]>
    remove(path: string): Promise<DriverJar[]>
    /** Show a managed JAR in the OS file manager. */
    reveal(path: string): Promise<void>
    /** Open the managed drivers folder. */
    openFolder(): Promise<void>
  }
  themes: {
    list(): Promise<ThemeManifestEntry[]>
    read(path: string): Promise<ThemeFile>
    /** Scan an installed VS Code / VSCodium extensions folder for themes. */
    importVsCodeExtensions(): Promise<ThemeManifestEntry[]>
  }
  settings: { get(): Promise<Record<string, unknown>>; set(patch: Record<string, unknown>): Promise<void> }
  ai: {
    /** Ask the configured provider; the schema of `connectionId` is included when available. */
    chat(connectionId: string | undefined, messages: AiMessage[]): Promise<AiChatResult>
  }
  tasks: {
    /** Recurring exports, soonest planned run first. */
    list(): Promise<ScheduledTask[]>
    /** Create or update by id and return the stored list. */
    save(input: TaskInput): Promise<ScheduledTask[]>
    remove(id: string): Promise<ScheduledTask[]>
    /** Run now (outside the schedule) and return the updated list. */
    run(id: string): Promise<ScheduledTask[]>
    /** Native save dialog for the output file, without writing it yet. */
    chooseOutput(defaultName: string, format: TaskFormat): Promise<string | null>
    /** Main -> renderer after any task is created, edited, run or deleted. */
    onChanged(cb: (tasks: ScheduledTask[]) => void): () => void
  }
  history: {
    /** Executed statements per connection, newest first. */
    get(): Promise<Record<string, string[]>>
    add(connectionId: string, statements: string[]): Promise<void>
  }
  dialogs: {
    pickFile(filters?: { name: string; extensions: string[] }[]): Promise<string | undefined>
    /** Read a text file through a native open dialog (UTF-8, BOM stripped); null when cancelled. */
    openText(filters?: SaveFilter[]): Promise<{ path: string; name: string; content: string } | null>
    /**
     * Open a data file for the import wizard. Text formats return UTF-8 `text`; `.xlsx`/`.xls`
     * return `base64` for the workbook reader. Null when cancelled; 64 MB limit.
     */
    openImport(filters?: SaveFilter[]): Promise<{ path: string; name: string; size: number; text?: string; base64?: string } | null>
  }
  script: {
    /**
     * Read a file named by `@include`. Relative paths resolve next to the including script, or in
     * the user's Documents folder for the top-level console. BOM stripped; 16 MB limit.
     */
    read(path: string, from?: string): Promise<{ path: string; name: string; content: string }>
    /**
     * Save a SQL script. A path the user opened or already saved to is overwritten; any other
     * path (including a restored one after a restart) opens the native save dialog first.
     * Returns the chosen path, or null when cancelled.
     */
    write(path: string | undefined, content: string, defaultName?: string): Promise<string | null>
  }
  docker: {
    /** Read-only container listing for the Docker helper (unix socket or TCP daemon). */
    list(endpoint: DockerEndpoint): Promise<DockerContainer[]>
  }
  export: {
    /** Save text through a native save dialog; returns the chosen path or null when cancelled. */
    save(defaultName: string, content: string, filters?: SaveFilter[]): Promise<string | null>
    /** Save base64-encoded bytes (raster export) through a native save dialog. */
    saveBinary(defaultName: string, base64: string, filters?: SaveFilter[]): Promise<string | null>
    /** Print a standalone SVG as a single-page vector PDF sized to the diagram. */
    pdf(defaultName: string, svg: string, size: { width: number; height: number }): Promise<string | null>
  }
  update: {
    /** Current updater state; the renderer also receives every transition through onState. */
    state(): Promise<UpdateState>
    /** Manual check. Resolves with the state after the feed answers. */
    check(): Promise<UpdateState>
    /** Download the available update. */
    download(): Promise<UpdateState>
    /** Restart and install a downloaded update. */
    install(): Promise<void>
    /** Open the matching GitHub Release in the browser. */
    openReleasePage(): Promise<void>
    /** Main -> renderer update state transitions. Returns an unsubscribe function. */
    onState(cb: (state: UpdateState) => void): () => void
  }
  window: {
    minimize(): Promise<void>
    /** Maximize when restored, restore when maximized. */
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
    /** Pop up the application menu under a title-bar button, in window coordinates. */
    showMenu(position: { x: number; y: number }): Promise<void>
    /** Main -> renderer maximize/restore transitions. Returns an unsubscribe function. */
    onMaximized(cb: (maximized: boolean) => void): () => void
  }
  /** Main -> renderer menu commands (global menu on macOS/Linux, window menu on Windows). */
  onCommand(cb: (cmd: string, arg?: unknown) => void): () => void
  platform: NodeJS.Platform
}

declare global { interface Window { stratum: StratumApi } }
