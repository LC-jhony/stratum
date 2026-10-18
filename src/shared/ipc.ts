import type { DockerContainer, DockerEndpoint } from './docker'
import type { ConnectionConfig, DatabaseModel, QueryResult, ThemeFile, ThemeManifestEntry } from './types'

/** Native save-dialog filter (matches Electron's FileFilter). */
export interface SaveFilter { name: string; extensions: string[] }

/** Single typed contract between renderer and main. Every channel is request/response. */
export interface StratumApi {
  connections: {
    list(): Promise<ConnectionConfig[]>
    save(c: ConnectionConfig): Promise<void>
    remove(id: string): Promise<void>
    test(c: ConnectionConfig): Promise<{ ok: boolean; version?: string; error?: string }>
    open(id: string): Promise<{ version?: string }>
    close(id: string): Promise<void>
  }
  db: {
    introspect(id: string): Promise<DatabaseModel>
    execute(id: string, sql: string, opts?: { limit?: number; offset?: number }): Promise<QueryResult>
    cancel(id: string): Promise<void>
    /** Apply edits from the data grid (DataGrip "Submit"). Runs inside one transaction. */
    submit(id: string, statements: string[]): Promise<{ ok: boolean; error?: string }>
  }
  themes: {
    list(): Promise<ThemeManifestEntry[]>
    read(path: string): Promise<ThemeFile>
    /** Scan an installed VS Code / VSCodium extensions folder for themes. */
    importVsCodeExtensions(): Promise<ThemeManifestEntry[]>
  }
  settings: { get(): Promise<Record<string, unknown>>; set(patch: Record<string, unknown>): Promise<void> }
  dialogs: { pickFile(filters?: { name: string; extensions: string[] }[]): Promise<string | undefined> }
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
  /** Main -> renderer menu commands (global menu on macOS/Linux, window menu on Windows). */
  onCommand(cb: (cmd: string, arg?: unknown) => void): () => void
  platform: NodeJS.Platform
}

declare global { interface Window { stratum: StratumApi } }
