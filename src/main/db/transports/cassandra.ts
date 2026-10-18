import { Client } from 'cassandra-driver'
import type { ColumnInfo, ColumnMeta, ConnectionConfig, RawResult, SchemaInfo, TableInfo } from '../../../shared/types'
import { cassandraIdent, cqlHead, isCassandraRead, parseCassandraPage, parseCassandraUse } from '../../../core/cassandra'
import type { Transport } from '../types'

/**
 * Cassandra transport (read-only MVP).
 *
 * The console speaks CQL: `SELECT`, `USE` (kept as session state and applied through the driver's
 * per-query `keyspace` option, so it survives routing across hosts) and client-side `DESCRIBE`
 * helpers (`DESCRIBE KEYSPACES|TABLES|TABLE ks.tbl`). Everything else — `INSERT`, `UPDATE`,
 * `DELETE`, `TRUNCATE`, `CREATE`/`ALTER`/`DROP`, `BATCH` — fails before reaching the cluster.
 *
 * CQL has no `OFFSET`, so the grid's paging re-runs the read from the first row and walks
 * Cassandra's native page states until it reaches the requested window (bounded by `MAX_WALK`).
 * The Explorer model comes from `system_schema.keyspaces/tables/columns`: keyspaces are schemas,
 * tables are tables, and partition/clustering keys are marked as primary keys.
 *
 * Reads are out of scope for writes by design (like the MongoDB, Redis and Elasticsearch MVPs).
 */

const DEFAULT_PORT = 9042
const DEFAULT_DC = 'datacenter1'
/** fetchSize ceiling: rows requested per native page. */
const MAX_PAGE = 5000
/** How many rows a paged read may walk from the first row to satisfy an offset. */
const MAX_WALK = 20000
const MAX_KEYSPACES = 100
const MAX_TABLES = 2000
const MAX_COLUMNS = 200
const FETCH_META = 5000

export interface CassandraResultSet extends AsyncIterable<unknown> {
  columns: { name: string }[]
  rows: unknown[]
  pageState?: Buffer | string | null
}

export interface CassandraExecuteOptions {
  fetchSize?: number
  pageState?: Buffer | string
  prepare?: boolean
  keyspace?: string
}

/** The slice of cassandra-driver's Client the transport uses; tests inject a fake of this shape. */
export interface CassandraClient {
  connect(): Promise<void>
  execute(query: string, params?: unknown[], options?: CassandraExecuteOptions): Promise<CassandraResultSet>
  shutdown(): Promise<void>
}

export type CassandraClientFactory = (cfg: ConnectionConfig) => CassandraClient

export function createCassandraClient(cfg: ConnectionConfig): CassandraClient {
  const host = cfg.host?.trim() || '127.0.0.1'
  const port = cfg.port && cfg.port > 0 ? cfg.port : DEFAULT_PORT
  return new Client({
    contactPoints: [host],
    protocolOptions: { port },
    localDataCenter: cfg.dataCenter?.trim() || DEFAULT_DC,
    keyspace: cfg.database?.trim() || undefined,
    credentials: cfg.user?.trim() ? { username: cfg.user.trim(), password: cfg.password ?? '' } : undefined,
    sslOptions: cfg.ssl ? {} : undefined,
    socketOptions: { readTimeout: 15_000 },
  }) as unknown as CassandraClient
}

interface DescribeQuery { kind: 'query'; cql: string; params?: unknown[] }
interface DescribeTable { kind: 'table'; keyspace?: string; table: string }
type DescribeTarget = DescribeQuery | DescribeTable

export class CassandraTransport implements Transport {
  private client: CassandraClient
  /** Current `USE` keyspace; passed per query so it follows the driver's host routing. */
  private keyspace?: string

  constructor(private cfg: ConnectionConfig, make: CassandraClientFactory = createCassandraClient) {
    this.client = make(cfg)
    this.keyspace = cfg.database?.trim() || undefined
  }

  async open(): Promise<{ version?: string }> {
    try {
      await this.client.connect()
    } catch (e) {
      throw new Error(`Cassandra connection to ${this.contact()} failed: ${msg(e)}`)
    }
    try {
      const rs = await this.client.execute('SELECT release_version FROM system.local', [], { prepare: false })
      const row = await firstObject(rs)
      const version = row?.release_version
      return { version: typeof version === 'string' ? version : undefined }
    } catch {
      return {} // connected: system.local can be restricted, the version is a nicety
    }
  }

  async query(sql: string): Promise<RawResult> {
    const page = parseCassandraPage(sql)
    const cql = (page?.cql ?? sql).trim()
    if (!cql) throw new Error('Empty Cassandra statement.')

    const use = parseCassandraUse(cql)
    if (use) return this.use(use)

    if (cqlHead(cql) === 'DESCRIBE') return this.describe(cql)

    if (!isCassandraRead(cql)) {
      throw new Error(`Statement not allowed: this Cassandra console is read-only (SELECT, USE and DESCRIBE only).`)
    }
    return this.readPaged(cql, page?.offset ?? 0, page?.limit ?? 500)
  }

  /** The driver has no query cancel; close stays explicit and aborts nothing mid-flight. */
  async cancel(): Promise<void> { /* no-op */ }

  async close(): Promise<void> {
    try { await this.client.shutdown() } catch { /* already closed or never connected */ }
  }

  /* -------------------------------------------------- statements */

  private async use(name: string): Promise<RawResult> {
    const rs = await this.client.execute('SELECT keyspace_name FROM system_schema.keyspaces WHERE keyspace_name = ?', [name], { prepare: false })
    if ((await allObjects(rs)).length === 0) throw new Error(`Keyspace "${name}" does not exist.`)
    this.keyspace = name
    return { columns: [], rows: [] }
  }

  private describe(cql: string): Promise<RawResult> | RawResult {
    const target = describeTarget(cql)
    if (!target) throw new Error('DESCRIBE supports KEYSPACES, TABLES or TABLE <keyspace>.<table>.')
    if (target.kind === 'query') return this.readPaged(target.cql, 0, 500, target.params ?? [], false)
    const keyspace = target.keyspace ?? this.keyspace
    if (!keyspace) throw new Error('DESCRIBE TABLE needs a keyspace: DESCRIBE TABLE <keyspace>.<table> (or run USE <keyspace> first).')
    return this.readPaged(
      'SELECT column_name, kind, position, type FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?',
      0, 500, [keyspace, target.table], false,
    )
  }

  /* -------------------------------------------------- reads + paging */

  private async readPaged(cql: string, offset: number, limit: number, params: unknown[] = [], useKeyspace = true): Promise<RawResult> {
    const target = Math.min(Math.max(1, offset + limit), MAX_WALK)
    const fetchSize = Math.max(1, Math.min(MAX_PAGE, target))
    const rs = await this.client.execute(cql, params, { fetchSize, prepare: false, keyspace: useKeyspace ? this.keyspace : undefined })
    const columns: ColumnMeta[] = (rs.columns ?? []).map((c) => ({ name: c.name }))
    const all: unknown[][] = []
    for await (const row of rs) {
      if (all.length >= target) break
      all.push(rowValues(row, columns))
    }
    return { columns, rows: all.slice(offset) }
  }

  /* -------------------------------------------------- explorer model */

  async introspectModel(): Promise<{ schemas: SchemaInfo[] }> {
    const [keyspaceRows, tableRows, columnRows] = await Promise.all([
      this.metadata('SELECT keyspace_name FROM system_schema.keyspaces'),
      this.metadata('SELECT keyspace_name, table_name FROM system_schema.tables'),
      this.metadata('SELECT keyspace_name, table_name, column_name, kind, position, type FROM system_schema.columns'),
    ])

    const columnsByTable = new Map<string, PendingColumn[]>()
    for (const row of columnRows) {
      const key = tableKey(row.keyspace_name, row.table_name)
      const list = columnsByTable.get(key) ?? []
      list.push({
        name: String(row.column_name ?? ''),
        dataType: String(row.type ?? 'unknown'),
        kind: String(row.kind ?? ''),
        position: Number(row.position ?? 0),
      })
      columnsByTable.set(key, list)
    }

    const tablesByKeyspace = new Map<string, TableInfo[]>()
    for (const row of tableRows) {
      const keyspace = String(row.keyspace_name ?? '')
      const name = String(row.table_name ?? '')
      if (!keyspace || !name) continue
      const list = tablesByKeyspace.get(keyspace) ?? []
      if (list.length >= MAX_TABLES) continue
      list.push({
        name,
        kind: 'table',
        columns: columnsOf(columnsByTable.get(tableKey(row.keyspace_name, row.table_name)) ?? []),
        foreignKeys: [],
        indexes: [],
      })
      tablesByKeyspace.set(keyspace, list)
    }

    const schemas = keyspaceRows
      .map((row) => String(row.keyspace_name ?? ''))
      .filter(Boolean)
      .sort()
      .slice(0, MAX_KEYSPACES)
      .map((name) => ({ name, tables: (tablesByKeyspace.get(name) ?? []).sort((a, b) => a.name.localeCompare(b.name)) }))
    return { schemas }
  }

  private async metadata(cql: string): Promise<Record<string, unknown>[]> {
    return allObjects(await this.client.execute(cql, [], { fetchSize: FETCH_META, prepare: false }))
  }

  private contact(): string {
    const host = this.cfg.host?.trim() || '127.0.0.1'
    return `${host}:${this.cfg.port && this.cfg.port > 0 ? this.cfg.port : DEFAULT_PORT}`
  }
}

/* ------------------------------------------------------------------ helpers */

interface PendingColumn { name: string; dataType: string; kind: string; position: number }

const tableKey = (keyspace: unknown, table: unknown) => `${String(keyspace ?? '')}\u0000${String(table ?? '')}`

/** Partition keys first (by position), then clustering keys, then regular columns alphabetically. */
function columnsOf(pending: PendingColumn[]): ColumnInfo[] {
  const rank = (p: PendingColumn) => (p.kind === 'partition_key' ? 0 : p.kind === 'clustering_key' ? 1 : 2)
  return [...pending]
    .sort((a, b) => {
      const ra = rank(a), rb = rank(b)
      if (ra !== rb) return ra - rb
      if (ra < 2) return a.position - b.position
      return a.name.localeCompare(b.name)
    })
    .slice(0, MAX_COLUMNS)
    .map((p, ordinal) => ({
      name: p.name,
      dataType: p.dataType,
      nullable: p.kind === 'regular',
      isPrimaryKey: p.kind === 'partition_key' || p.kind === 'clustering_key',
      ordinal,
    }))
}

function describeTarget(cql: string): DescribeTarget | undefined {
  const m = /^DESCRIBE\s+([\s\S]+?)\s*;?\s*$/i.exec(cql.trim())
  if (!m) return undefined
  const arg = m[1].trim()
  if (/^KEYSPACES$/i.test(arg)) return { kind: 'query', cql: 'SELECT keyspace_name FROM system_schema.keyspaces' }
  if (/^TABLES$/i.test(arg)) return { kind: 'query', cql: 'SELECT keyspace_name, table_name FROM system_schema.tables' }
  const table = /^TABLE\s+(?:("(?:[^"]|"")*"|[A-Za-z][A-Za-z0-9_]*)\s*\.\s*)?("(?:[^"]|"")*"|[A-Za-z][A-Za-z0-9_]*)$/i.exec(arg)
  if (!table) return undefined
  return { kind: 'table', keyspace: table[1] ? cassandraIdent(table[1]) : undefined, table: cassandraIdent(table[2]) }
}

function rowValues(row: unknown, columns: ColumnMeta[]): unknown[] {
  const r = row as { values?: () => unknown[] }
  if (typeof r?.values === 'function') return r.values()
  if (Array.isArray(row)) return row
  return columns.map((c) => (row as Record<string, unknown> | null)?.[c.name] ?? null)
}

function rowObject(row: unknown): Record<string, unknown> {
  const r = row as { keys?: () => string[]; values?: () => unknown[] }
  if (typeof r?.keys === 'function' && typeof r.values === 'function') {
    const keys = r.keys(), values = r.values()
    return Object.fromEntries(keys.map((k, i) => [k, values[i]]))
  }
  return row && typeof row === 'object' ? (row as Record<string, unknown>) : {}
}

async function firstObject(rs: CassandraResultSet): Promise<Record<string, unknown> | undefined> {
  for await (const row of rs) return rowObject(row)
  return undefined
}

async function allObjects(rs: CassandraResultSet): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  for await (const row of rs) out.push(rowObject(row))
  return out
}

function msg(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause
    return cause instanceof Error ? `${e.message} (${cause.message})` : e.message
  }
  return String(e)
}
