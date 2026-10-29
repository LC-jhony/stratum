import { Client } from 'pg'
import type { ConnectionConfig, RawResult } from '../../../shared/types'
import type { Transport } from '../types'
import { isConnectionError, transactionState } from './tx'

const OID: Record<number, string> = { 16: 'bool', 17: 'bytea', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 114: 'json', 700: 'float4', 701: 'float8', 1043: 'varchar', 1082: 'date', 1114: 'timestamp', 1184: 'timestamptz', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb' }

export class PostgresTransport implements Transport {
  private client?: Client
  private version?: string
  /** The socket emitted `error` or the driver reported a connection-level failure. */
  private broken = false
  private inTx = false
  private opening?: Promise<Client>
  /** pg serialises at the protocol level only per query; this queue keeps concurrent callers safe. */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private cfg: ConnectionConfig) {}

  private options() {
    const c = this.cfg
    return {
      host: c.socketPath?.trim() || c.host || 'localhost',
      port: c.port ?? 5432,
      user: c.user,
      password: c.password,
      database: c.database,
      // Certificate verification is opt-in: existing profiles that only enable SSL keep working.
      ssl: c.ssl ? { rejectUnauthorized: c.sslVerify === true } : undefined,
      connectionTimeoutMillis: 10_000,
    }
  }

  /** An idle socket that dies raises `error`; without this listener Node would crash the main process. */
  private attach(client: Client) {
    client.on('error', (e: Error) => {
      this.broken = true
      console.warn('postgres connection lost:', e.message)
    })
  }

  private connect(): Promise<Client> {
    return (this.opening ??= (async () => {
      const previous = this.client
      this.client = undefined
      if (previous) await previous.end().catch(() => {})
      const client = new Client(this.options())
      this.attach(client)
      try {
        await client.connect()
        if (this.cfg.readonly) await client.query('set default_transaction_read_only = on')
        const v = await client.query('show server_version')
        this.version = String(v.rows[0]?.server_version ?? '')
        this.client = client
        this.broken = false
        return client
      } catch (e) {
        this.broken = true
        await client.end().catch(() => {})
        throw e
      } finally {
        this.opening = undefined
      }
    })())
  }

  private async current(force = false): Promise<Client> {
    if (!force && this.client && !this.broken) return this.client
    if (this.opening) return this.opening
    if (this.inTx) throw new Error('The PostgreSQL connection was lost during a transaction. Roll back and retry the operation.')
    return this.connect()
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.catch(() => undefined)
    return run
  }

  async open() {
    await this.current(true)
    return { version: this.version }
  }

  query(sql: string): Promise<RawResult> {
    return this.enqueue(async () => {
      const client = await this.current()
      try {
        const r = await client.query({ text: sql, rowMode: 'array' })
        const res = Array.isArray(r) ? r[r.length - 1] : r
        this.inTx = transactionState(sql, this.inTx)
        return {
          columns: (res.fields ?? []).map((f: { name: string; dataTypeID: number }) => ({ name: f.name, type: OID[f.dataTypeID] ?? String(f.dataTypeID) })),
          rows: res.rows as unknown[][],
          affectedRows: res.rowCount ?? undefined,
        }
      } catch (e) {
        if (isConnectionError(e)) {
          this.broken = true
          if (this.inTx) throw new Error('The PostgreSQL connection was lost during a transaction. Nothing was committed: roll back and retry.')
        }
        throw e
      }
    })
  }

  /** Connection id used by cancel and by the live tests. */
  processId(): number | undefined {
    return (this.client as unknown as { processID?: number })?.processID
  }

  async cancel() {
    const pid = this.processId()
    if (!pid || this.broken) return
    const side = new Client(this.options())
    try { await side.connect(); await side.query('select pg_cancel_backend($1)', [pid]) } finally { await side.end().catch(() => {}) }
  }

  async close() {
    await this.opening?.catch(() => undefined)
    const client = this.client
    this.client = undefined
    this.broken = true
    this.inTx = false
    await client?.end().catch(() => {})
  }
}
