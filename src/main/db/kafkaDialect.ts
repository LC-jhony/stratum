import type { KafkaTransport } from './transports/kafka'
import { isKafkaRead, paginateKafkaStatement } from './transports/kafka'
import type { Dialect } from './types'

/**
 * Kafka "dialect": the only statement is the internal `CONSUME "<topic>"` reader the data editor
 * emits, so paging and the read gate come from the transport and the model is one `topics` schema.
 */
export function createKafkaDialect(transport: KafkaTransport): Dialect {
  return {
    id: 'generic',
    quote: (s) => s,
    qualify: (_schema, table) => table,
    paginate: paginateKafkaStatement,
    isRead: isKafkaRead,
    introspect: () => transport.introspectModel(),
  }
}
