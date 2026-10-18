import { isCassandraRead, paginateCassandraStatement } from '../../core/cassandra'
import { qualify as qualifyId, quote as quoteId } from '../../core/quoting'
import type { CassandraTransport } from './transports/cassandra'
import type { Dialect } from './types'

/**
 * Cassandra "dialect": CQL reads and paging are text-level rules from shared/cassandra.ts, while
 * the model comes from the transport (system_schema) because it needs the driver rather than
 * generated statements. The id is 'cassandra' so identifier quoting (double quotes) and the
 * completion catalogs line up with DataGrip's CQL support.
 */
export function createCassandraDialect(transport: CassandraTransport): Dialect {
  return {
    id: 'cassandra',
    quote: (s) => quoteId('cassandra', s),
    qualify: (schema, table) => qualifyId('cassandra', schema, table),
    paginate: paginateCassandraStatement,
    isRead: isCassandraRead,
    introspect: () => transport.introspectModel(),
  }
}
