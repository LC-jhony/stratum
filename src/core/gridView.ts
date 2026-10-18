/**
 * Client-side view helpers for result grids: quick filter + single-column sort over the rows a
 * page already loaded. Pure (no DOM, no React) so the console applies them to the grid and tests
 * exercise them directly.
 */

export type SortDir = 1 | -1
export interface GridSort { col: number; dir: SortDir }

const isNum = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))

/** Numbers (and driver numerics sent as text) by value, booleans, then case-insensitive natural
 *  order; nulls always sink — mirroring SQL, a descending sort flips them to the top. */
function compare(a: unknown, b: unknown): number {
  const an = a === null || a === undefined, bn = b === null || b === undefined
  if (an || bn) return an === bn ? 0 : an ? 1 : -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  if (typeof a !== 'boolean' && typeof b !== 'boolean' && a !== '' && b !== '' && isNum(a) && isNum(b)) return Number(a) - Number(b)
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

/** Keep rows matching the query in any column, case-insensitive. Nulls match "null"; objects match their JSON. */
export function filterRows(rows: unknown[][], query: string): unknown[][] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  return rows.filter((r) => r.some((v) => {
    const t = v === null || v === undefined ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    return t.toLowerCase().includes(q)
  }))
}

/** Sort a copy by one column; the original order is kept for equal values. */
export function sortRows(rows: unknown[][], sort: GridSort | null): unknown[][] {
  if (!sort) return rows
  return [...rows].sort((a, b) => compare(a[sort.col], b[sort.col]) * sort.dir)
}
