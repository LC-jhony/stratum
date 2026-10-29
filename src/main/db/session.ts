import type { ConnectionConfig, DatabaseModel, QueryResult } from '../../shared/types'
import { readOnlyViolation, returnsRows, stripLeadingComments } from '../../core/sql'
import { normalizeRows } from './normalize'
import type { Dialect, Transport } from './types'

export const DEFAULT_PAGE = 500

export interface ExecuteOptions { limit?: number; offset?: number; /** Return complete binary values (export flow). */ full?: boolean }

/** One live data source: a Transport + a Dialect + policy (read-only, paging, error shaping). */
export class DbSession {
  version?: string
  constructor(readonly config: ConnectionConfig, private transport: Transport, readonly dialect: Dialect) {}

  async open() { const r = await this.transport.open(); this.version = r.version; return r }
  close() { return this.transport.close() }
  cancel() { return this.transport.cancel() }
  /** Server-side connection id (diagnostics and live tests). */
  processId(): number | undefined { return this.transport.processId?.() }

  async introspect(): Promise<DatabaseModel> {
    const m = await this.dialect.introspect((sql) => this.transport.query(sql))
    return { dialect: this.dialect.id, version: this.version, kind: this.config.kind, ...m }
  }

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
      const paged = reads ? this.dialect.paginate(sql, limit + 1, offset) : undefined
      const raw = await this.transport.query(paged ?? sql)
      const normalized = normalizeRows(raw.rows, opts.full === true)
      let rows = normalized.rows
      let hasMore = false
      if (rows.length > limit) { hasMore = true; rows = rows.slice(0, limit) }
      return { ...base, columns: raw.columns, rows, affectedRows: raw.affectedRows, hasMore, truncatedBinary: normalized.truncatedBinary, durationMs: Math.round(performance.now() - t0) }
    } catch (e) {
      return { ...base, durationMs: Math.round(performance.now() - t0), error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** Apply grid edits atomically; drivers that reject BEGIN (some JDBC autocommit setups) run statement-by-statement. */
  async submit(statements: string[]): Promise<{ ok: boolean; error?: string }> {
    if (this.config.readonly) return { ok: false, error: 'Data source is read-only.' }
    if (this.dialect.isRead) return { ok: false, error: `Grid editing is not supported for ${this.config.kind} sources.` }
    let tx = true
    try { await this.transport.query('BEGIN') } catch { tx = false }
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
      if (tx) await this.transport.query('COMMIT')
      return { ok: true }
    } catch (e) {
      if (tx) await this.transport.query('ROLLBACK').catch(() => {})
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
}
