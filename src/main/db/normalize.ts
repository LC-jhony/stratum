/** Make driver values safe and readable across the IPC boundary. */
export function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v).toString('hex')
    return `\\x${hex.length > 64 ? hex.slice(0, 64) + '…' : hex}`
  }
  if (typeof v === 'object') { try { return JSON.stringify(v) } catch { return String(v) } }
  return v
}
export const normalizeRows = (rows: unknown[][]) => rows.map((r) => r.map(normalizeValue))
