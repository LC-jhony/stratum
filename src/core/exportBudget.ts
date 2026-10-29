/**
 * Paging policy for "Export all rows". The renderer must never pull millions of rows into one IPC
 * payload: it asks for fixed-size blocks (already paginated by the session) and stops on a row or
 * memory budget with a message the user can act on, never a silent truncation.
 */

/** Rows fetched per request; keeps each IPC payload bounded. */
export const EXPORT_BLOCK = 5_000
/** Hard stop for a desktop grid export. */
export const EXPORT_MAX_ROWS = 1_000_000
/** Rough UTF-16 budget for the rows held in memory (strings dominate); ~256 MB at 2 bytes/char. */
export const EXPORT_MAX_CHARS = 128_000_000

/** Cheap size estimate used for the memory budget; JSON values are rare in grid rows. */
export function rowChars(row: unknown[]): number {
  let n = 16
  for (const v of row) {
    if (typeof v === 'string') n += v.length * 2
    else if (v === null || v === undefined) n += 4
    else if (typeof v === 'object') { try { n += JSON.stringify(v).length * 2 } catch { n += 32 } }
    else n += 16
  }
  return n
}

export interface ExportPage {
  rows: unknown[][]
  hasMore: boolean
  error?: string
}

export interface CollectOptions {
  /** Rows already held by the grid, contiguous from `offset`. */
  head: unknown[][]
  /** Server offset of `head[0]`. */
  offset: number
  /** Whether the server has more rows after `head`. */
  hasMore: boolean
  fetchPage(offset: number, limit: number): Promise<ExportPage>
  onProgress?(loaded: number, fetched: number): void
  block?: number
  maxRows?: number
  maxChars?: number
}

const fmt = (n: number): string => n.toLocaleString('en-US')

/**
 * Returns `head` plus every remaining server row. Throws (rather than truncating) when a page
 * fails or a budget is reached, so the caller can show the reason next to the grid.
 */
export async function collectRows(opts: CollectOptions): Promise<unknown[][]> {
  const block = opts.block ?? EXPORT_BLOCK
  const maxRows = opts.maxRows ?? EXPORT_MAX_ROWS
  const maxChars = opts.maxChars ?? EXPORT_MAX_CHARS
  const out = [...opts.head]
  let chars = out.reduce((n, r) => n + rowChars(r), 0)
  if (out.length > maxRows) throw new Error(`This result has more than ${fmt(maxRows)} rows. Narrow the query.`)
  if (chars > maxChars) throw new Error(`The loaded rows would need more than ${Math.round((maxChars * 2) / 1_000_000)} MB of memory. Narrow the query.`)
  let offset = opts.offset + out.length
  let fetched = 0
  opts.onProgress?.(out.length, fetched)
  while (opts.hasMore) {
    const page = await opts.fetchPage(offset, block)
    if (page.error) throw new Error(`Fetching rows from offset ${fmt(offset)} failed: ${page.error}`)
    if (!page.rows.length) break
    for (const r of page.rows) chars += rowChars(r)
    out.push(...page.rows)
    fetched += page.rows.length
    offset += page.rows.length
    if (out.length > maxRows) throw new Error(`This result has more than ${fmt(maxRows)} rows. Narrow the query, or export the loaded rows instead.`)
    if (chars > maxChars) throw new Error(`Stopped at ${fmt(out.length)} rows: the export would need more than ${Math.round((maxChars * 2) / 1_000_000)} MB of memory. Narrow the query, or export the loaded rows instead.`)
    opts.onProgress?.(out.length, fetched)
    if (!page.hasMore) break
  }
  return out
}
