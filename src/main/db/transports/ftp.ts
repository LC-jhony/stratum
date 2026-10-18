import { Client } from 'basic-ftp'
import type { FileInfo } from 'basic-ftp'
import type { ColumnMeta, ConnectionConfig, RawResult, SchemaInfo, TableInfo } from '../../../shared/types'
import type { Transport } from '../types'

/**
 * FTP/FTPS transport (read-only MVP).
 *
 * There is no query console: the Explorer shows one `files` schema whose tables are the root
 * directory (`(root)`) plus each of its folders (one level, capped). Opening a table runs the
 * internal reader `LIST "<path>" <offset> <limit>`, which lists that directory and slices the
 * window locally — FTP has no listing offsets and the server always returns the whole directory, so
 * each call is capped at `MAX_ENTRIES` before slicing. Nothing is uploaded, renamed or deleted, and
 * no other statement kind reaches the client.
 *
 * `secure` enables explicit FTPS (AUTH TLS); implicit FTPS is not offered because it is the legacy,
 * non-standard variant. Anonymous access is the default when no user is configured.
 */

const DEFAULT_PORT = 21
const MAX_DIRS = 100
const MAX_ENTRIES = 10000

export const FILE_COLUMNS: ColumnMeta[] = [
  { name: 'name' },
  { name: 'type' },
  { name: 'size' },
  { name: 'modified' },
  { name: 'permissions' },
]

export interface FtpClientLike {
  access(options: { host: string; port: number; user: string; password: string; secure: boolean }): Promise<unknown>
  list(path?: string): Promise<FileInfo[]>
  close(): void
}
export type FtpClientFactory = (cfg: ConnectionConfig) => FtpClientLike

export function createFtpClient(): FtpClientLike {
  return new Client(15_000) as unknown as FtpClientLike
}

export interface FtpList {
  path: string
  offset: number
  limit: number
}

const LIST_STATEMENT = /^LIST[ \t]+("(?:[^"\\]|\\.)*"|\S+)(?:[ \t]+(\d+))?(?:[ \t]+(\d+))?[ \t]*;?[ \t]*$/i

/** `LIST "<path>" [offset] [limit]` — the only statement this transport executes. */
export function parseFtpList(stmt: string): FtpList | undefined {
  const m = LIST_STATEMENT.exec(stmt.trim())
  if (!m) return undefined
  let path = m[1]
  if (path.startsWith('"')) {
    try { path = String(JSON.parse(path)) } catch { /* keep the raw token */ }
  }
  return { path: normalizePath(path), offset: Number(m[2] ?? 0) || 0, limit: Number(m[3] ?? 500) || 500 }
}

export function isFtpRead(stmt: string): boolean {
  return parseFtpList(stmt) !== undefined
}

export function paginateFtpStatement(stmt: string, limit: number, offset: number): string | undefined {
  const list = parseFtpList(stmt)
  return list ? `LIST ${JSON.stringify(list.path)} ${offset} ${limit}` : undefined
}

export class FtpTransport implements Transport {
  private client: FtpClientLike
  private root: FileInfo[] = []
  private rootLoaded = false

  constructor(private cfg: ConnectionConfig, make: FtpClientFactory = createFtpClient) {
    this.client = make(cfg)
  }

  async open(): Promise<{ version?: string }> {
    try {
      await this.client.access({
        host: this.cfg.host?.trim() || 'localhost',
        port: this.cfg.port && this.cfg.port > 0 ? this.cfg.port : DEFAULT_PORT,
        user: this.cfg.user?.trim() || 'anonymous',
        password: this.cfg.password ?? (this.cfg.user ? '' : 'anonymous@'),
        secure: !!this.cfg.ssl,
      })
      this.root = await this.client.list('/')
      this.rootLoaded = true
      return {}
    } catch (e) {
      throw new Error(`FTP connection to ${this.target()} failed: ${msg(e)}`)
    }
  }

  async query(stmt: string): Promise<RawResult> {
    const list = parseFtpList(stmt)
    if (!list) throw new Error('FTP has no query console in this build: open a folder in the Explorer to list its files.')
    const entries = (await this.client.list(list.path)).slice(0, MAX_ENTRIES)
    return {
      columns: FILE_COLUMNS,
      rows: entries.slice(list.offset, list.offset + list.limit).map(rowOf),
    }
  }

  async cancel(): Promise<void> { /* basic-ftp has no query cancel; close stays explicit */ }

  async close(): Promise<void> {
    try { this.client.close() } catch { /* already closed */ }
  }

  async introspectModel(): Promise<{ schemas: SchemaInfo[] }> {
    if (!this.rootLoaded) {
      try {
        this.root = await this.client.list('/')
        this.rootLoaded = true
      } catch {
        this.root = [] // unreadable root: the connection still works for known paths
      }
    }
    const dirs = this.root
      .filter((f) => f.isDirectory)
      .map((f) => f.name)
      .sort()
      .slice(0, MAX_DIRS)
    return { schemas: [{ name: 'files', tables: [filesTable('(root)'), ...dirs.map((dir) => filesTable(dir))] }] }
  }

  private target(): string {
    const host = this.cfg.host?.trim() || 'localhost'
    return `${host}:${this.cfg.port && this.cfg.port > 0 ? this.cfg.port : DEFAULT_PORT}`
  }
}

function normalizePath(path: string): string {
  const absolute = path.startsWith('/') ? path : `/${path}`
  return absolute.length > 1 && absolute.endsWith('/') ? absolute.slice(0, -1) : absolute
}

function rowOf(file: FileInfo): unknown[] {
  const modified = file.modifiedAt && !Number.isNaN(file.modifiedAt.getTime())
    ? file.modifiedAt
    : file.rawModifiedAt || null
  return [
    file.name,
    file.isDirectory ? 'folder' : file.isSymbolicLink ? 'link' : 'file',
    file.isDirectory ? null : file.size,
    modified,
    permissionString(file.permissions),
  ]
}

function permissionString(permissions?: { user: number; group: number; world: number }): string | null {
  if (!permissions) return null
  const bits = (n: number) => 'rwx'.split('').map((char, i) => (n & (4 >> i) ? char : '-')).join('')
  return bits(permissions.user) + bits(permissions.group) + bits(permissions.world)
}

function filesTable(name: string): TableInfo {
  return {
    name,
    kind: 'table',
    columns: FILE_COLUMNS.map((column, ordinal) => ({
      name: column.name,
      dataType: column.name === 'size' ? 'int64' : column.name === 'modified' ? 'timestamp' : 'string',
      nullable: column.name !== 'name',
      isPrimaryKey: false,
      ordinal,
    })),
    foreignKeys: [],
    indexes: [],
  }
}

function msg(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause
    return cause instanceof Error ? `${e.message} (${cause.message})` : e.message
  }
  return String(e)
}
