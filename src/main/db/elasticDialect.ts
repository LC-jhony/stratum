import { isElasticRead, paginateElasticStatement } from '../../shared/elastic'
import type { ElasticTransport } from './transports/elastic'
import type { Dialect } from './types'

/**
 * Elasticsearch "dialect": like the Mongo and Redis ones it reuses the SQL dialect machinery but
 * speaks a different language. Introspection runs through the transport itself (indices as tables,
 * mappings as columns) because it needs HTTP rather than generated statements; read detection and
 * paging delegate to the parser in shared/elastic.ts.
 */
export function createElasticDialect(transport: ElasticTransport): Dialect {
  return {
    id: 'generic',
    quote: (s) => s,
    qualify: (_schema, table) => table,
    paginate: paginateElasticStatement,
    isRead: isElasticRead,
    introspect: () => transport.introspectModel(),
  }
}
