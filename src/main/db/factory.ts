import type { ConnectionConfig } from '../../shared/types'
import { dialects } from './dialects'
import { DbSession } from './session'
import { JdbcTransport } from './transports/jdbc'
import { MysqlTransport } from './transports/mysql'
import { PostgresTransport } from './transports/postgres'
import { SqliteTransport } from './transports/sqlite'
import type { JdbcSidecar } from '../services/jdbcSidecar'

/** The only place that knows which transport/dialect pairs exist. Add a database here. */
export function createSession(cfg: ConnectionConfig, sidecar: JdbcSidecar): DbSession {
  switch (cfg.kind) {
    case 'postgres': return new DbSession(cfg, new PostgresTransport(cfg), dialects.postgres)
    case 'mysql': return new DbSession(cfg, new MysqlTransport(cfg), dialects.mysql)
    case 'sqlite': return new DbSession(cfg, new SqliteTransport(cfg), dialects.sqlite)
    case 'jdbc': return new DbSession(cfg, new JdbcTransport(cfg, sidecar), dialects[cfg.jdbc?.dialect ?? 'generic'])
  }
}
