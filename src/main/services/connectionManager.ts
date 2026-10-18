import type { ConnectionConfig } from '../../shared/types'
import { createSessionWithTunnel } from '../db/factory'
import type { DbSession } from '../db/session'
import type { JdbcSidecar } from './jdbcSidecar'
import type { ConnectionStore } from './store'

export class ConnectionManager {
  private sessions = new Map<string, DbSession>()
  constructor(private store: ConnectionStore, private sidecar: JdbcSidecar) {}

  async test(cfg: ConnectionConfig) {
    try {
      // A separate id keeps this tunnel apart from a live session's (and from concurrent tests).
      const s = await createSessionWithTunnel({ ...cfg, id: `test-${cfg.id}` }, this.sidecar)
      try { const r = await s.open(); return { ok: true, version: r.version } }
      finally { await s.close() }
    } catch (e) {
      // Tunnel or transport failure: report it in the dialog status line instead of rejecting.
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  async open(id: string) {
    const existing = this.sessions.get(id)
    if (existing) return { version: existing.version }
    const cfg = await this.store.get(id)
    if (!cfg) throw new Error(`Unknown data source ${id}`)
    const s = await createSessionWithTunnel(cfg, this.sidecar)
    try {
      const r = await s.open()
      this.sessions.set(id, s)
      return r
    } catch (e) {
      await s.close() // a failed open must release the SSH tunnel it may have acquired
      throw e
    }
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
