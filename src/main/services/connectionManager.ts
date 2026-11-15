import type { ConnectionConfig, SessionStateChange } from '../../shared/types'
import type { DbSession } from '../db/session'
import type { ConnectionStore } from './store'
import type { SessionFactory } from './sessionFactory'

export interface ConnectionManagerOptions {
  /** Pushed to the renderer when a session closes without a user action (idle timeout, lost socket). */
  onSessionState?: (state: SessionStateChange) => void
  /** How often idle/keep-alive rules are evaluated. */
  tickMs?: number
}

/** Tracks live sessions. Process/tunnel lifecycle belongs to SessionFactory and the app composition. */
export class ConnectionManager {
  private sessions = new Map<string, DbSession>()
  /** Last user activity per connection; keep-alive pings never reset it, so idle-close follows real use. */
  private lastUsed = new Map<string, number>()
  private pinging = new Set<string>()
  private timer?: ReturnType<typeof setInterval>

  constructor(private store: ConnectionStore, private factory: SessionFactory, private opts: ConnectionManagerOptions = {}) {
    this.timer = setInterval(() => this.sweep(), opts.tickMs ?? 15_000)
    // Do not keep the Node event loop (or a test process) alive just for the sweep.
    this.timer.unref?.()
  }

  async test(cfg: ConnectionConfig) {
    try {
      // A separate id keeps this tunnel apart from a live session's (and from concurrent tests).
      const s = await this.factory.createWithTunnel({ ...cfg, id: `test-${cfg.id}` })
      try { const r = await s.open(); return { ok: true, version: r.version } }
      finally { await s.close() }
    } catch (e) {
      // Tunnel or transport failure: report it in the dialog status line instead of rejecting.
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async open(id: string) {
    const existing = this.sessions.get(id)
    if (existing) { this.touch(id); return { version: existing.version } }
    const cfg = await this.store.get(id)
    if (!cfg) throw new Error(`Unknown data source ${id}`)
    const s = await this.factory.createWithTunnel(cfg)
    try {
      const r = await s.open()
      this.sessions.set(id, s)
      this.touch(id)
      return r
    } catch (e) {
      await s.close() // a failed open must release the SSH tunnel it may have acquired
      throw e
    }
  }

  /** Close and re-open: applies edited settings, init SQL and a fresh tunnel. */
  async reconnect(id: string) { await this.close(id); return this.open(id) }

  /** Re-open if the user changed the config, so edits take effect without restarting. */
  async reset(id: string) { await this.close(id) }

  require(id: string): DbSession {
    const s = this.sessions.get(id)
    if (!s) throw new Error('Data source is not connected.')
    this.touch(id)
    return s
  }

  async close(id: string) {
    const s = this.sessions.get(id)
    this.sessions.delete(id)
    this.lastUsed.delete(id)
    this.pinging.delete(id)
    await s?.close()
  }

  async closeAll() { await Promise.all([...this.sessions.keys()].map((id) => this.close(id))) }

  /** Stop the idle sweep (application quit and tests). */
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = undefined } }

  private touch(id: string) { this.lastUsed.set(id, Date.now()) }

  /** Enforce keep-alive and idle-close without ever abandoning an open transaction. */
  private sweep() {
    const now = Date.now()
    for (const [id, s] of [...this.sessions]) {
      const cfg = s.config.session
      if (!cfg) continue
      const idleMs = now - (this.lastUsed.get(id) ?? now)
      const inTransaction = s.transaction().open
      if (cfg.idleTimeoutSeconds && cfg.idleTimeoutSeconds > 0 && idleMs >= cfg.idleTimeoutSeconds * 1000 && !inTransaction) {
        void this.close(id).then(() => this.opts.onSessionState?.({ id, status: 'closed', reason: 'idle timeout' }))
        continue
      }
      const keepAlive = cfg.keepAliveSeconds
      if (!keepAlive || keepAlive <= 0 || idleMs < keepAlive * 1000 || this.pinging.has(id)) continue
      this.pinging.add(id)
      void s.ping()
        .catch((e: unknown) => this.close(id).then(() => this.opts.onSessionState?.({ id, status: 'lost', reason: e instanceof Error ? e.message : String(e) })))
        .finally(() => this.pinging.delete(id))
    }
  }
}
