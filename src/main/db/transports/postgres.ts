import { Client } from 'pg'
import type { ConnectionConfig, RawResult } from '../../../shared/types'
import type { Transport } from '../types'

const OID: Record<number, string> = { 16: 'bool', 17: 'bytea', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 114: 'json', 700: 'float4', 701: 'float8', 1043: 'varchar', 1082: 'date', 1114: 'timestamp', 1184: 'timestamptz', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb' }

export class PostgresTransport implements Transport {
  private client?: Client
  constructor(private cfg: ConnectionConfig) {}
  private options() {
    const c = this.cfg
    return { host: c.socketPath?.trim() || c.host || 'localhost', port: c.port ?? 5432, user: c.user, password: c.password, database: c.database, ssl: c.ssl ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 10_000 }
  }
  async open() {
    this.client = new Client(this.options())
    await this.client.connect()
    const v = await this.client.query('show server_version')
    if (this.cfg.readonly) await this.client.query('set default_transaction_read_only = on')
    return { version: String(v.rows[0]?.server_version ?? '') }
  }
  async query(sql: string): Promise<RawResult> {
    const r = await this.client!.query({ text: sql, rowMode: 'array' })
    const res = Array.isArray(r) ? r[r.length - 1] : r
    return { columns: (res.fields ?? []).map((f: { name: string; dataTypeID: number }) => ({ name: f.name, type: OID[f.dataTypeID] ?? String(f.dataTypeID) })), rows: res.rows as unknown[][], affectedRows: res.rowCount ?? undefined }
  }
  async cancel() {
    const pid = (this.client as unknown as { processID?: number })?.processID
    if (!pid) return
    const side = new Client(this.options())
    try { await side.connect(); await side.query('select pg_cancel_backend($1)', [pid]) } finally { await side.end().catch(() => {}) }
  }
  async close() { await this.client?.end().catch(() => {}); this.client = undefined }
}
