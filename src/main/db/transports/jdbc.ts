import type { ConnectionConfig, RawResult } from '../../../shared/types'
import type { Transport } from '../types'
import { JdbcSidecar } from '../../services/jdbcSidecar'

interface ExecuteResponse { affectedRows?: number; err?: string; rows?: unknown[][]; columns?: { name: string; type?: string; orgTable?: string }[] }
interface ConnectResponse { success: boolean; err?: string; fullErr?: string; version?: string }

/** Talks to database-client/jdbc-adapter-server (MIT) over its HTTP API. */
export class JdbcTransport implements Transport {
  constructor(private cfg: ConnectionConfig, private sidecar: JdbcSidecar) {}
  private post<T>(endpoint: string, body: unknown): Promise<T> { return this.sidecar.post<T>(endpoint, body) }
  async open() {
    const j = this.cfg.jdbc
    if (!j) throw new Error('Missing JDBC settings')
    await this.sidecar.ensureRunning()
    const r = await this.post<ConnectResponse>('connect', {
      id: this.cfg.id, jdbcUrl: j.url, driver: j.driverClass || undefined, driverPath: j.driverPath,
      username: this.cfg.user, password: this.cfg.password, readonly: !!this.cfg.readonly,
    })
    if (!r.success) throw new Error(r.err ?? 'JDBC connection failed')
    return { version: r.version }
  }
  async query(sql: string): Promise<RawResult> {
    const r = await this.post<ExecuteResponse>('execute', { id: this.cfg.id, sql })
    if (r.err) throw new Error(r.err)
    return { columns: (r.columns ?? []).map((c) => ({ name: c.name, type: c.type, table: c.orgTable })), rows: r.rows ?? [], affectedRows: r.affectedRows }
  }
  async cancel() { await this.post('cancel', { id: this.cfg.id }) }
  async close() { await this.post('close', { id: this.cfg.id }).catch(() => {}) }
}
