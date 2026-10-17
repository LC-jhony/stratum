import { createConnection, type Connection, type ConnectionOptions } from 'mysql2/promise'
import type { ConnectionConfig, RawResult } from '../../../shared/types'
import type { Transport } from '../types'

export class MysqlTransport implements Transport {
  private conn?: Connection
  constructor(private cfg: ConnectionConfig) {}
  private options(): ConnectionOptions {
    const c = this.cfg
    return { host: c.host ?? 'localhost', port: c.port ?? 3306, user: c.user, password: c.password, database: c.database, ssl: c.ssl ? { rejectUnauthorized: false } : undefined, rowsAsArray: true, dateStrings: false, supportBigNumbers: true, bigNumberStrings: true, connectTimeout: 10_000 }
  }
  async open() {
    this.conn = await createConnection(this.options())
    if (this.cfg.readonly) await this.conn.query('set session transaction read only')
    const [rows] = await this.conn.query('select version() as v')
    return { version: String((rows as unknown[][])[0]?.[0] ?? '') }
  }
  async query(sql: string): Promise<RawResult> {
    const [res, fields] = await this.conn!.query({ sql, rowsAsArray: true })
    if (Array.isArray(res)) {
      return { columns: ((fields ?? []) as { name: string; columnType?: number }[]).map((f) => ({ name: f.name, type: f.columnType !== undefined ? String(f.columnType) : undefined })), rows: res as unknown[][] }
    }
    return { columns: [], rows: [], affectedRows: (res as { affectedRows?: number }).affectedRows ?? 0 }
  }
  async cancel() {
    const id = (this.conn as unknown as { threadId?: number })?.threadId
    if (!id) return
    const side = await createConnection({ ...this.options(), rowsAsArray: false })
    try { await side.query(`KILL QUERY ${Number(id)}`) } finally { await side.end().catch(() => {}) }
  }
  async close() { await this.conn?.end().catch(() => {}); this.conn = undefined }
}
