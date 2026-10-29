/** Transaction boundaries as seen by a transport, which must never reconnect in the middle of one. */

const TX_START = /^\s*(begin|start\s+transaction|savepoint)\b/i
const TX_END = /^\s*(commit|end|rollback)\b/i

export const startsTransaction = (sql: string): boolean => TX_START.test(sql)
export const endsTransaction = (sql: string): boolean => TX_END.test(sql)

/** True after the statement has run: BEGIN/SAVEPOINT enter, COMMIT/ROLLBACK leave. */
export const transactionState = (sql: string, inTransaction: boolean): boolean => {
  if (endsTransaction(sql)) return false
  if (startsTransaction(sql)) return true
  return inTransaction
}

/** Driver errors that mean the socket is unusable (as opposed to a SQL or constraint error). */
const CONNECTION_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH',
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'ER_SERVER_SHUTDOWN',
])
export function isConnectionError(e: unknown): boolean {
  const code = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : ''
  // PostgreSQL class 08 = connection exception; 57P01..57P03 = admin shutdown/crash/cannot connect.
  return CONNECTION_CODES.has(code) || /^08/.test(code) || /^57P0[123]$/.test(code)
}
