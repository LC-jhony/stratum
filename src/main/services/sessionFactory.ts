import type { ConnectionConfig } from '../../shared/types'
import { createSession } from '../db/factory'
import type { DbSession } from '../db/session'
import { JdbcTransport } from '../db/transports/jdbc'
import type { JdbcSidecar } from './jdbcSidecar'
import { acquireTunnel } from './sshTunnel'

/**
 * Session composition: owns the SSH tunnel and injects the JDBC transport. `ConnectionManager`
 * only tracks live sessions; the registry stays free of process and network lifecycle.
 */
export class SessionFactory {
  constructor(private sidecar: JdbcSidecar) {}

  create(cfg: ConnectionConfig): DbSession {
    return createSession(cfg, {
      jdbcTransport: (config) => new JdbcTransport(config, this.sidecar),
    })
  }

  async createWithTunnel(cfg: ConnectionConfig): Promise<DbSession> {
    const { config, release } = await acquireTunnel(cfg)
    const session = this.create(config)
    if (!cfg.ssh?.enabled) return session
    const close = session.close.bind(session)
    session.close = () => close().finally(release) // release() is idempotent, close() may run twice
    return session
  }
}
