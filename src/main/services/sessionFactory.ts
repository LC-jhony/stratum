import type { ConnectionConfig } from '../../shared/types'
import { createSession } from '../db/factory'
import type { DbSession } from '../db/session'
import { JdbcTransport } from '../db/transports/jdbc'
import type { JdbcSidecar } from './jdbcSidecar'
import { acquireProxy } from './proxy'
import { acquireTunnel } from './sshTunnel'

/**
 * Session composition: owns the connection helper (SSH tunnel or SOCKS/HTTP proxy) and injects the
 * JDBC transport. `ConnectionManager` only tracks live sessions; the registry stays free of process
 * and network lifecycle.
 */
export class SessionFactory {
  constructor(private sidecar: JdbcSidecar) {}

  create(cfg: ConnectionConfig): DbSession {
    return createSession(cfg, {
      jdbcTransport: (config) => new JdbcTransport(config, this.sidecar),
    })
  }

  async createWithTunnel(cfg: ConnectionConfig): Promise<DbSession> {
    const helper = cfg.ssh?.enabled ? await acquireTunnel(cfg) : await acquireProxy(cfg)
    const session = this.create(helper.config)
    if (!cfg.ssh?.enabled && !cfg.proxy?.enabled) return session
    const close = session.close.bind(session)
    session.close = () => close().finally(helper.release) // release() is idempotent, close() may run twice
    return session
  }
}
