import { createConnection, type Connection, type ConnectionOptions } from 'mysql2/promise'
import type { ConnectionConfig, RawResult } from '../../../shared/types'
import { logger } from '../../logger'
import { sslMaterial } from '../ssl'
import type { Transport } from '../types'
import { isConnectionError, transactionState } from './tx'

export class MysqlTransport implements Transport {
  private conn?: Connection
  private version?: string
  private broken = false
  private inTx = false
  private opening?: Promise<Connection>

  constructor(private cfg: ConnectionConfig) {}

  private async options(): Promise<ConnectionOptions> {
    const c = this.cfg
    const socket = c.socketPath?.trim()
    const tls = await sslMaterial(c)
    return {
      ...(socket ? { socketPath: socket } : { host: c.host ?? 'localhost', port: c.port ?? 3306 }),
      user: c.user,
      password: c.password,
      database: c.database,
      // Certificate verification is opt-in: existing profiles that only enable SSL keep working.
      ssl: c.ssl ? { rejectUnauthorized: c.sslVerify === true, ...tls } : undefined,
      rowsAsArray: true,
      dateStrings: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      connectTimeout: c.session?.connectTimeoutMs ?? 10_000,
    }
  }

  private attach(conn: Connection) {
    conn.on('error', (e: Error) => {
      this.broken = true
      logger.warn('mysql connection lost', e.message)
    })
  }

  private connect(): Promise<Connection> {
    return (this.opening ??= (async () => {
      const previous = this.conn
      this.conn = undefined
      if (previous) await previous.end().catch(() => {})
      const conn = await createConnection(await this.options())
      this.attach(conn)
      try {
        if (this.cfg.readonly) await conn.query('set session transaction read only')
        const [rows] = await conn.query('select version() as v')
        this.version = String((rows as unknown[][])[0]?.[0] ?? '')
        this.conn = conn
        this.broken = false
        return conn
      } catch (e) {
        this.broken = true
        await conn.end().catch(() => {})
        throw e
      } finally {
        this.opening = undefined
      }
    })())
  }

  private async current(force = false): Promise<Connection> {
    if (!force && this.conn && !this.broken) return this.conn
    if (this.opening) return this.opening
    if (this.inTx) throw new Error('The MySQL connection was lost during a transaction. Roll back and retry the operation.')
    return this.connect()
  }

  async open() {
    await this.current(true)
    return { version: this.version }
  }

  async query(sql: string): Promise<RawResult> {
    const conn = await this.current()
    try {
      const [res, fields] = await conn.query({ sql, rowsAsArray: true })
      this.inTx = transactionState(sql, this.inTx)
      if (Array.isArray(res)) {
        return {
          columns: ((fields ?? []) as { name: string; columnType?: number }[]).map((f) => ({ name: f.name, type: f.columnType !== undefined ? String(f.columnType) : undefined })),
          rows: res as unknown[][],
        }
      }
      return { columns: [], rows: [], affectedRows: (res as { affectedRows?: number }).affectedRows ?? 0 }
    } catch (e) {
      if (isConnectionError(e)) {
        this.broken = true
        if (this.inTx) throw new Error('The MySQL connection was lost during a transaction. Nothing was committed: roll back and retry.')
      }
      throw e
    }
  }

  processId(): number | undefined {
    return (this.conn as unknown as { threadId?: number })?.threadId
  }

  async cancel() {
    const id = this.processId()
    if (!id || this.broken) return
    const side = await createConnection({ ...(await this.options()), rowsAsArray: false })
    try { await side.query(`KILL QUERY ${Number(id)}`) } finally { await side.end().catch(() => {}) }
  }

  inTransaction(): boolean { return this.inTx }

  async ping() { await this.query('select 1') }

  async close() {
    await this.opening?.catch(() => undefined)
    const conn = this.conn
    this.conn = undefined
    this.broken = true
    this.inTx = false
    await conn?.end().catch(() => {})
  }
}
