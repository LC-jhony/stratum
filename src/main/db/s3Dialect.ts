import type { S3Transport } from './transports/s3'
import { isS3Read, paginateS3Statement } from './transports/s3'
import type { Dialect } from './types'

/**
 * S3 "dialect": there is no statement language beyond the internal `LIST "<bucket>"` reader the
 * data editor emits, so paging and the read gate come from the transport and the model is fetched
 * with `ListBuckets`. Quoting/qualifying are inert because the UI never builds SQL for this kind.
 */
export function createS3Dialect(transport: S3Transport): Dialect {
  return {
    id: 'generic',
    quote: (s) => s,
    qualify: (_schema, table) => table,
    paginate: paginateS3Statement,
    isRead: isS3Read,
    introspect: () => transport.introspectModel(),
  }
}
