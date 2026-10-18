import type { RabbitMqTransport } from './transports/rabbitmq'
import { isRabbitRead, paginateRabbitStatement } from './transports/rabbitmq'
import type { Dialect } from './types'

/**
 * RabbitMQ "dialect": the only statement is the internal `PEEK "<vhost>" "<queue>"` reader the
 * data editor emits, so paging and the read gate come from the transport and the model comes from
 * the Management API (`/api/queues`, one schema per vhost).
 */
export function createRabbitDialect(transport: RabbitMqTransport): Dialect {
  return {
    id: 'generic',
    quote: (s) => s,
    qualify: (_schema, table) => table,
    paginate: paginateRabbitStatement,
    isRead: isRabbitRead,
    introspect: () => transport.introspectModel(),
  }
}
