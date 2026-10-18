import type { ConnectionConfig } from '../../shared/types'
import { isRedisRead, paginateRedisStatement, type RedisTransport } from './transports/redis'
import type { Dialect } from './types'

/**
 * Redis "dialect": like the Mongo one it reuses the SQL dialect machinery but speaks a different
 * language. Introspection runs through the transport itself (databases → schemas, sampled keys →
 * tables) because it needs the dedicated scanner connection, not because it builds statements;
 * read detection and paging delegate to the parser in transports/redis.ts.
 */
export function createRedisDialect(cfg: ConnectionConfig, transport: RedisTransport): Dialect {
  return {
    id: 'generic',
    quote: (s) => s,
    qualify: (_schema, table) => table,
    paginate: paginateRedisStatement,
    isRead: isRedisRead,
    introspect: () => transport.introspectModel(),
  }
}
