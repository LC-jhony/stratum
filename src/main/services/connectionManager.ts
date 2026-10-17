import type { ConnectionConfig } from '../../shared/types'
import { createSession } from '../db/factory'
import type { DbSession } from '../db/session'
import type { JdbcSidecar } from './jdbcSidecar'
import type { ConnectionStore } from './store'

export class ConnectionManager {
  private sessions = new Map<string, DbSession>()
  constructor(private store: ConnectionStore, private sidecar: JdbcSidecar) {}

  async test(cfg: ConnectionConfig) {
    const s = createSession({ ...cfg, id: `test-${cfg.id}` }, this.sidecar)
    try { const r = await s.open(); return { ok: true, version: r.version } }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
    finally { await s.close() }
  }
  async open(id: string) {
    const existing = this.sessions.get(id)
    if (existing) return { version: existing.version }
    const cfg = await this.store.get(id)
    if (!cfg) throw new Error(`Unknown data source ${id}`)
    const s = createSession(cfg, this.sidecar)
    const r = await s.open()
    this.sessions.set(id, s)
    return r
  }
  /** Re-open if the user changed the config, so edits take effect without restarting. */
  async reset(id: string) { await this.close(id) }
  require(id: string): DbSession {
    const s = this.sessions.get(id)
    if (!s) throw new Error('Data source is not connected.')
    return s
  }
  async close(id: string) { const s = this.sessions.get(id); this.sessions.delete(id); await s?.close() }
  async closeAll() { await Promise.all([...this.sessions.keys()].map((id) => this.close(id))); this.sidecar.stop() }
}
