import type {
  ConnectionConfig, DatabaseModel, QueryPlan, QueryResult, RawResult, SessionInfo, TransactionState,
} from '../../shared/types'
import { isSqlKind } from '../../core/kinds'
import { explainStatement, mysqlPlanFromJson, pgPlanFromJson, sqlitePlanFromRows, textPlan } from '../../core/plan'
import { quote } from '../../core/quoting'
import { readOnlyViolation, returnsRows, splitStatements, stripLeadingComments } from '../../core/sql'
import { normalizeRows } from './normalize'
import type { Dialect, Transport } from './types'

export const DEFAULT_PAGE = 500

export interface ExecuteOptions { limit?: number; offset?: number; /** Return complete binary values (export flow). */ full?: boolean }

const TX_COMMAND = /^\s*(begin|start\s+transaction|commit|end|rollback)\b/i
const PG_FAMILY = new Set(['postgres', 'greenplum', 'cockroach', 'redshift', 'vertica'])
const MYSQL_FAMILY = new Set(['mysql', 'mariadb'])
const ISO_SQL = new Set(['postgres', 'greenplum', 'cockroach', 'redshift', 'vertica', 'mysql', 'mariadb'])

const asText = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v))
const asNumber = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined)
const asBool = (v: unknown): boolean => v === true || v === 1 || v === '1' || /^true$/i.test(String(v))

function records(raw: RawResult): Record<string, unknown>[] {
  return raw.rows.map((row) => Object.fromEntries(raw.columns.map((c, i) => [c.name.toLowerCase(), row[i]])))
}

/** Raw result rendered as text (generic EXPLAIN, diagnostics). */
function rawText(raw: RawResult): string {
  if (!raw.rows.length) return ''
  if (!raw.columns.length) return raw.rows.map((r) => r.join('\t')).join('\n')
  return [raw.columns.map((c) => c.name).join('\t'), ...raw.rows.map((r) => r.map((v) => (v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v))).join('\t'))].join('\n')
}

/** One live data source: a Transport + a Dialect + policy (read-only, paging, transactions, plans). */
export class DbSession {
  version?: string
  /** Transaction begun by Stratum (auto-commit off or an explicit Begin), or seen in the statement text. */
  private txOpen = false
  private txSince?: number
  /** Set when the driver reported that the transaction can only be rolled back. */
  private txFailed = false
  /** Savepoints created from this session, shown in the transaction bar. */
  private savepoints: string[] = []

  constructor(readonly config: ConnectionConfig, private transport: Transport, readonly dialect: Dialect) {}

  private get autoCommit(): boolean { return this.config.session?.autoCommit !== false }

  async open() {
    const r = await this.transport.open()
    this.version = r.version
    await this.applySessionSetup()
    this.syncTransaction()
    return r
  }

  close() {
    this.savepoints = []
    // Leaving a transaction open across a reconnect is an invitation to half-applied changes.
    return (this.txOpen ? this.transport.query('ROLLBACK').catch(() => undefined) : Promise.resolve(undefined)).then(() => this.transport.close())
  }
  cancel() { return this.transport.cancel() }
  /** Server-side connection id (diagnostics and live tests). */
  processId(): number | undefined { return this.transport.processId?.() }

  /** Keep-alive round trip; never enters the transaction nor runs user SQL. */
  async ping() {
    if (this.transport.ping) await this.transport.ping()
    else await this.transport.query('select 1')
  }

  async introspect(): Promise<DatabaseModel> {
    const m = await this.dialect.introspect((sql) => this.transport.query(sql))
    return { dialect: this.dialect.id, version: this.version, kind: this.config.kind, ...m }
  }

  /* ------------------------------------------------------------------ session setup */

  /** Applies init SQL, default schema/catalog and isolation after every open or reconnect. */
  private async applySessionSetup() {
    const s = this.config.session
    if (!s || !isSqlKind(this.config.kind)) return
    const d = this.dialect.id
    if (s.defaultCatalog && MYSQL_FAMILY.has(d)) await this.transport.query(`use ${quote(d, s.defaultCatalog)}`)
    else if ((s.defaultCatalog ?? s.defaultSchema) && MYSQL_FAMILY.has(d)) await this.transport.query(`use ${quote(d, (s.defaultCatalog ?? s.defaultSchema)!)}`)
    if (s.defaultSchema && PG_FAMILY.has(d)) {
      const path = s.defaultSchema.split(',').map((x) => quote(d, x.trim())).filter(Boolean).join(', ')
      if (path) await this.transport.query(`set search_path to ${path}`)
    }
    if (s.isolation && s.isolation !== 'default' && d !== 'sqlite') {
      const iso = s.isolation.toUpperCase()
      if (PG_FAMILY.has(d)) await this.transport.query(`set session characteristics as transaction isolation level ${iso}`)
      else if (MYSQL_FAMILY.has(d)) await this.transport.query(`set session transaction isolation level ${iso}`)
      else if (ISO_SQL.has(d)) await this.transport.query(`set transaction isolation level ${iso}`)
    }
    if (s.initSql?.trim()) {
      for (const stmt of splitStatements(s.initSql)) await this.transport.query(stmt.text)
    }
  }

  /* ------------------------------------------------------------------ transactions */

  private syncTransaction() {
    const actual = this.transport.inTransaction?.()
    if (actual === undefined) return
    if (actual && !this.txOpen) this.txSince = Date.now()
    if (!actual) { this.txSince = undefined; this.txFailed = false; this.savepoints = [] }
    this.txOpen = actual
  }

  transaction(): TransactionState {
    this.syncTransaction()
    return {
      open: this.txOpen, autoCommit: this.autoCommit, since: this.txSince, failed: this.txFailed || undefined,
      savepoints: this.savepoints.length ? [...this.savepoints] : undefined,
    }
  }

  private txState(): TransactionState { return this.transaction() }

  async begin(): Promise<TransactionState> {
    if (this.txOpen) return this.txState()
    await this.transport.query('BEGIN')
    this.txOpen = true
    this.txSince = Date.now()
    this.txFailed = false
    return this.txState()
  }

  async commit(): Promise<TransactionState> {
    if (this.txOpen) await this.transport.query('COMMIT')
    this.txOpen = false; this.txSince = undefined; this.txFailed = false; this.savepoints = []
    this.syncTransaction()
    return this.txState()
  }

  async rollback(): Promise<TransactionState> {
    if (this.txOpen) await this.transport.query('ROLLBACK')
    this.txOpen = false; this.txSince = undefined; this.txFailed = false; this.savepoints = []
    this.syncTransaction()
    return this.txState()
  }

  /* ------------------------------------------------------------------ savepoints */

  private savepointName(name: string): string {
    const trimmed = name.trim()
    if (!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(trimmed)) {
      throw new Error('Savepoint names must start with a letter or underscore and contain only letters, digits, _ or $.')
    }
    return trimmed
  }

  /** SAVEPOINT grammar differs by engine; every branch is built from a validated identifier. */
  private savepointSql(action: 'create' | 'rollback' | 'release', name: string): string {
    const d = this.dialect.id
    if (d === 'mssql' || d === 'sybase') {
      if (action === 'create') return `SAVE TRANSACTION ${name}`
      if (action === 'rollback') return `ROLLBACK TRANSACTION ${name}`
      throw new Error('SQL Server has no RELEASE SAVEPOINT statement.')
    }
    if (d === 'oracle') {
      if (action === 'create') return `SAVEPOINT ${name}`
      if (action === 'rollback') return `ROLLBACK TO SAVEPOINT ${name}`
      // Oracle has no RELEASE statement: savepoints vanish on commit/rollback.
      throw new Error('Oracle has no RELEASE SAVEPOINT statement.')
    }
    if (d === 'sqlite') {
      if (action === 'create') return `SAVEPOINT ${name}`
      if (action === 'rollback') return `ROLLBACK TO ${name}`
      return `RELEASE ${name}`
    }
    if (d === 'db2') {
      if (action === 'create') return `SAVEPOINT ${name} ON ROLLBACK RETAIN CURSORS`
      if (action === 'rollback') return `ROLLBACK TO SAVEPOINT ${name}`
      return `RELEASE TO SAVEPOINT ${name}`
    }
    if (action === 'create') return `SAVEPOINT ${name}`
    if (action === 'rollback') return `ROLLBACK TO SAVEPOINT ${name}`
    return `RELEASE SAVEPOINT ${name}`
  }

  /** Creates a savepoint, opening a transaction first when auto-commit would reject it. */
  async savepoint(name: string): Promise<TransactionState> {
    const safe = this.savepointName(name)
    if (!this.txOpen) await this.begin()
    await this.transport.query(this.savepointSql('create', safe))
    if (!this.savepoints.includes(safe)) this.savepoints.push(safe)
    this.syncTransaction()
    return this.txState()
  }

  async rollbackToSavepoint(name: string): Promise<TransactionState> {
    const safe = this.savepointName(name)
    if (!this.txOpen) throw new Error('There is no open transaction to roll back.')
    await this.transport.query(this.savepointSql('rollback', safe))
    const at = this.savepoints.indexOf(safe)
    if (at >= 0) this.savepoints = this.savepoints.slice(0, at + 1) // the savepoint itself stays usable
    this.syncTransaction()
    return this.txState()
  }

  async releaseSavepoint(name: string): Promise<TransactionState> {
    const safe = this.savepointName(name)
    if (!this.txOpen) throw new Error('There is no open transaction.')
    await this.transport.query(this.savepointSql('release', safe))
    const at = this.savepoints.indexOf(safe)
    // PostgreSQL, SQLite and Db2 drop the named savepoint and every later one; MySQL only the named one.
    if (at >= 0) {
      const onlyNamed = MYSQL_FAMILY.has(this.dialect.id)
      this.savepoints = onlyNamed
        ? this.savepoints.filter((_, i) => i !== at)
        : this.savepoints.slice(0, at)
    }
    this.syncTransaction()
    return this.txState()
  }

  /** With auto-commit off, the first statement opens the transaction DataGrip shows in the toolbar. */
  private async ensureImplicitTransaction(sql: string) {
    if (this.autoCommit || this.txOpen || !isSqlKind(this.config.kind) || TX_COMMAND.test(sql)) return
    await this.transport.query('BEGIN')
    this.txOpen = true
    this.txSince = Date.now()
    this.txFailed = false
  }

  /* ------------------------------------------------------------------ execution */

  /** Errors become part of the result (shown in the output pane), never thrown to the UI. */
  async execute(sql: string, opts: ExecuteOptions = {}): Promise<QueryResult> {
    const limit = opts.limit ?? DEFAULT_PAGE, offset = opts.offset ?? 0
    const base = { sql, offset, hasMore: false, columns: [], rows: [] as unknown[][] }
    const t0 = performance.now()
    try {
      const reads = this.dialect.isRead ? this.dialect.isRead(sql) : returnsRows(sql)
      if (this.config.readonly) {
        if (!reads) throw new Error('Data source is read-only.')
        const violation = readOnlyViolation(sql)
        if (violation) throw new Error(`Data source is read-only: ${violation}.`)
      }
      await this.ensureImplicitTransaction(sql)
      const paged = reads ? this.dialect.paginate(sql, limit + 1, offset) : undefined
      const raw = await this.transport.query(paged ?? sql)
      const normalized = normalizeRows(raw.rows, opts.full === true)
      let rows = normalized.rows
      let hasMore = false
      if (rows.length > limit) { hasMore = true; rows = rows.slice(0, limit) }
      return { ...base, columns: raw.columns, rows, affectedRows: raw.affectedRows, hasMore, truncatedBinary: normalized.truncatedBinary, durationMs: Math.round(performance.now() - t0) }
    } catch (e) {
      return { ...base, durationMs: Math.round(performance.now() - t0), error: e instanceof Error ? e.message : String(e) }
    } finally {
      this.syncTransaction()
    }
  }

  /** Apply grid edits atomically; an already-open transaction is used instead of opening a second one. */
  async submit(statements: string[]): Promise<{ ok: boolean; error?: string }> {
    if (this.config.readonly) return { ok: false, error: 'Data source is read-only.' }
    if (this.dialect.isRead) return { ok: false, error: `Grid editing is not supported for ${this.config.kind} sources.` }
    let own = false
    if (!this.txOpen) {
      try { await this.begin(); own = this.autoCommit } catch { own = false } // some JDBC autocommit setups reject BEGIN
    }
    try {
      for (const s of statements) {
        const raw = await this.transport.query(s)
        const updateOrDelete = /^(update|delete)\b/i.test(stripLeadingComments(s))
        // A grid edit that matches nothing is a bug in the UI state, not a success.
        if (updateOrDelete && raw.affectedRows === 0) {
          const preview = s.replace(/\s+/g, ' ').slice(0, 120)
          throw new Error(`No rows were affected by this statement: ${preview}`)
        }
      }
      if (own) await this.commit()
      return { ok: true }
    } catch (e) {
      if (own) await this.rollback().catch(() => undefined)
      else if (this.txOpen) this.txFailed = true
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      this.syncTransaction()
    }
  }

  /* ------------------------------------------------------------------ plan */

  /** EXPLAIN the statement; parse errors and unsupported databases stay inside the plan object. */
  async plan(sql: string): Promise<QueryPlan> {
    const t0 = performance.now()
    const target = explainStatement(this.dialect.id, sql)
    if (!target) {
      return { dialect: this.dialect.id, format: 'text', sql, durationMs: 0, root: { label: 'Execution plan' }, error: `Execution plans are not supported for ${this.config.kind} sources.` }
    }
    try {
      const raw = await this.transport.query(target.sql)
      const durationMs = Math.round(performance.now() - t0)
      if (target.parser === 'postgres') return { ...pgPlanFromJson(raw.rows[0]?.[0], sql, durationMs), dialect: this.dialect.id }
      if (target.parser === 'mysql') {
        const at = raw.columns.findIndex((c) => c.name.toLowerCase() === 'explain')
        return { ...mysqlPlanFromJson(raw.rows[0]?.[at >= 0 ? at : 0], sql, durationMs), dialect: this.dialect.id }
      }
      if (target.parser === 'sqlite') return { ...sqlitePlanFromRows(raw.rows, raw.columns, sql, durationMs), dialect: this.dialect.id }
      return textPlan(rawText(raw), sql, durationMs, this.dialect.id)
    } catch (e) {
      return { dialect: this.dialect.id, format: 'text', sql, durationMs: Math.round(performance.now() - t0), root: { label: 'Execution plan' }, error: e instanceof Error ? e.message : String(e) }
    } finally {
      this.syncTransaction()
    }
  }

  /* ------------------------------------------------------------------ session / lock monitor */

  async sessions(): Promise<SessionInfo[]> {
    if (PG_FAMILY.has(this.dialect.id)) {
      const raw = await this.transport.query(`select pid, usename, datname, coalesce(client_addr::text, 'local') as client, state, query,
        query_start, wait_event_type, wait_event, pg_blocking_pids(pid) as blocked_by, pid = pg_backend_pid() as current
        from pg_stat_activity
        order by query_start desc nulls last
        limit 200`)
      return records(raw).map((r) => ({
        pid: asNumber(r.pid) ?? String(r.pid), user: asText(r.usename), database: asText(r.datname), client: asText(r.client),
        state: asText(r.state), query: asText(r.query), startedAt: r.query_start instanceof Date ? r.query_start.toISOString() : asText(r.query_start),
        wait: [asText(r.wait_event_type), asText(r.wait_event)].filter(Boolean).join(': ') || undefined,
        blockedBy: Array.isArray(r.blocked_by) ? r.blocked_by.map(Number).filter((n) => Number.isFinite(n)) : undefined,
        current: asBool(r.current),
      }))
    }
    if (MYSQL_FAMILY.has(this.dialect.id)) {
      const raw = await this.transport.query(`select id as pid, user as usename, db as datname, host as client, command as state, info as query,
        time as seconds, state as wait, id = connection_id() as current
        from information_schema.processlist
        order by time desc
        limit 200`)
      return records(raw).map((r) => ({
        pid: asNumber(r.pid) ?? String(r.pid), user: asText(r.usename), database: asText(r.datname), client: asText(r.client),
        state: asText(r.state), query: asText(r.query), seconds: asNumber(r.seconds), wait: asText(r.wait), current: asBool(r.current),
      }))
    }
    throw new Error('The session monitor is available for PostgreSQL and MySQL data sources.')
  }

  async killSession(pid: number | string): Promise<void> {
    const n = Number(pid)
    if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid session id: ${String(pid)}`)
    if (PG_FAMILY.has(this.dialect.id)) {
      const raw = await this.transport.query(`select pg_terminate_backend(${n}) as killed`)
      const killed = raw.rows[0]?.[0]
      if (killed === false) throw new Error(`The server did not terminate session ${n}.`)
      return
    }
    if (MYSQL_FAMILY.has(this.dialect.id)) { await this.transport.query(`kill ${n}`); return }
    throw new Error('The session monitor is available for PostgreSQL and MySQL data sources.')
  }
}
