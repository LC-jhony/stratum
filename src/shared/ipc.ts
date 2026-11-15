import type { DockerContainer, DockerEndpoint } from './docker'
import type {
  ConnectionConfig, ConnectionView, DatabaseModel, QueryPlan, QueryResult, SavedQuery, SessionInfo,
  SessionStateChange, ThemeFile, ThemeManifestEntry, TransactionState,
} from './types'
import type { UpdateState } from './update'

/** Native save-dialog filter (matches Electron's FileFilter). */
export interface SaveFilter { name: string; extensions: string[] }

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
  themes: {
    list(): Promise<ThemeManifestEntry[]>
    read(path: string): Promise<ThemeFile>
    /** Scan an installed VS Code / VSCodium extensions folder for themes. */
    importVsCodeExtensions(): Promise<ThemeManifestEntry[]>
  }
  settings: { get(): Promise<Record<string, unknown>>; set(patch: Record<string, unknown>): Promise<void> }
  history: {
    /** Executed statements per connection, newest first. */
    get(): Promise<Record<string, string[]>>
    add(connectionId: string, statements: string[]): Promise<void>
  }
  dialogs: {
    pickFile(filters?: { name: string; extensions: string[] }[]): Promise<string | undefined>
    /** Read a text file through a native open dialog (UTF-8, BOM stripped); null when cancelled. */
    openText(filters?: SaveFilter[]): Promise<{ path: string; name: string; content: string } | null>
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
