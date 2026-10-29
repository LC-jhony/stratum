/** Make driver values safe and readable across the IPC boundary. */
export function normalizeValue(v: unknown, full = false): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v).toString('hex')
    // Full mode is used by "export all rows": the bytes must survive intact, whatever their size.
    if (full) return `\\x${hex}`
    return `\\x${hex.length > 64 ? hex.slice(0, 64) + '…' : hex}`
  }
  if (typeof v === 'object') { try { return JSON.stringify(v) } catch { return String(v) } }
  return v
}

export interface NormalizedRows {
  rows: unknown[][]
  /** At least one binary column was shortened to keep the grid payload small. */
  truncatedBinary: boolean
}

export function normalizeRows(rows: unknown[][], full = false): NormalizedRows {
  let truncatedBinary = false
  if (!full) truncatedBinary = rows.some((r) => r.some((v) => v instanceof Uint8Array && v.length > 32))
  return { rows: rows.map((r) => r.map((v) => normalizeValue(v, full))), truncatedBinary }
}
