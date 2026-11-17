import type { ConnectionConfig, DebugProbe, DebugRoutine, DebugSnapshot } from '../../shared/types'
import type { PostgresDebugSession } from '../debug/postgresDebugSession'
import { createPostgresDebugSession, listDebugRoutines, probeDebugSupport } from '../debug/postgresDebugSession'
import { acquireProxy } from './proxy'
import { acquireTunnel } from './sshTunnel'
import type { ConnectionStore } from './store'

type StepAction = 'continue' | 'step_over' | 'step_into'

/**
 * Owns debug sessions and the SSH/proxy helper they share. The renderer only sees session ids and
 * snapshots; credentials, ports and the two PostgreSQL connections stay in the main process.
 */
export class DebugService {
  private sessions = new Map<string, PostgresDebugSession>()
  private seq = 0

  constructor(private store: ConnectionStore) {}

  private async config(connectionId: string) {
    const cfg = await this.store.get(connectionId)
    if (!cfg) throw new Error(`Unknown data source ${connectionId}`)
    if (cfg.kind !== 'postgres') throw new Error('The routine debugger is available for PostgreSQL data sources only.')
    return cfg
  }

  /** One helper for both clients: the tunnel/proxy is refcounted and released with the session. */
  private helper(cfg: ConnectionConfig) {
    return cfg.ssh?.enabled ? acquireTunnel(cfg) : acquireProxy(cfg)
  }

  private session(id: string): PostgresDebugSession {
    const session = this.sessions.get(id)
    if (!session) throw new Error('This debug session has ended.')
    return session
  }

  async probe(connectionId: string): Promise<DebugProbe> {
    const cfg = await this.config(connectionId)
    const helper = await this.helper(cfg)
    try {
      return await probeDebugSupport(helper.config)
    } finally {
      helper.release()
    }
  }

  async routines(connectionId: string): Promise<DebugRoutine[]> {
    const cfg = await this.config(connectionId)
    const helper = await this.helper(cfg)
    try {
      return await listDebugRoutines(helper.config)
    } finally {
      helper.release()
    }
  }

  async start(connectionId: string, oid: number, values: string[]): Promise<DebugSnapshot> {
    const cfg = await this.config(connectionId)
    const helper = await this.helper(cfg)
    const id = `dbg-${Date.now().toString(36)}-${++this.seq}`
    // createPostgresDebugSession releases the helper when it cannot attach.
    const session = await createPostgresDebugSession(id, helper.config, oid, values, helper.release)
    this.sessions.set(id, session)
    return session.snapshot()
  }

  async snapshot(id: string): Promise<DebugSnapshot> {
    return this.session(id).liveSnapshot()
  }

  async step(id: string, action: StepAction): Promise<DebugSnapshot> {
    return this.session(id).step(action)
  }

  async selectFrame(id: string, level: number): Promise<DebugSnapshot> {
    return this.session(id).selectFrame(level)
  }

  async setBreakpoint(id: string, oid: number, line: number, enabled: boolean): Promise<DebugSnapshot> {
    return this.session(id).toggleBreakpoint(oid, line, enabled)
  }

  async setVariable(id: string, name: string, line: number, value: string): Promise<DebugSnapshot> {
    return this.session(id).setVariable(name, line, value)
  }

  /** Abort the target, roll back and close both connections; the final snapshot stays readable. */
  async stop(id: string): Promise<DebugSnapshot> {
    return this.session(id).stop()
  }

  /** Drop a stopped tab. A live session is stopped first so its target never outlives the tab. */
  async close(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    await session.stop().catch(() => undefined)
  }

  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(all.map((session) => session.stop().catch(() => undefined)))
  }
}
