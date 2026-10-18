import type { FtpTransport } from './transports/ftp'
import { isFtpRead, paginateFtpStatement } from './transports/ftp'
import type { Dialect } from './types'

/**
 * FTP "dialect": the only statement is the internal `LIST "<path>"` reader the data editor emits,
 * so paging and the read gate come from the transport and the model is one `files` schema.
 */
export function createFtpDialect(transport: FtpTransport): Dialect {
  return {
    id: 'generic',
    quote: (s) => s,
    qualify: (_schema, table) => table,
    paginate: paginateFtpStatement,
    isRead: isFtpRead,
    introspect: () => transport.introspectModel(),
  }
}
