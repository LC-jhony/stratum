/**
 * Pending grid edits → DML statements. Kept out of the React component so the exact SQL can be
 * previewed, confirmed and unit-tested without a database.
 */
import { quote } from './quoting'
import { buildDelete, buildInsert, buildUpdate, type RowKey } from './sqlgen'
import type { DialectId } from '../shared/types'

export interface GridChangeInput {
  /** Already qualified target, e.g. `public.customers`. */
  target: string
  dialect: DialectId
  /** Result column names, in grid order. */
  columns: string[]
  /** Primary-key column names; edits and deletes address rows through them. */
  primaryKey: string[]
  /** Loaded rows, excluding inserted ones. */
  rows: unknown[][]
  /** `row:column` → new value; rows are indexes into `rows`. */
  edits: ReadonlyMap<string, unknown>
  /** Indexes of deleted loaded rows. */
  deleted: ReadonlySet<number>
  /** Inserted rows, in grid-column order. */
  inserted: readonly unknown[][]
}

const isBlank = (v: unknown): boolean => v === null || v === undefined || v === ''

/** Generate UPDATE/DELETE for loaded rows followed by INSERT for new ones. */
export function gridChanges(input: GridChangeInput): string[] {
  const q = (name: string) => quote(input.dialect, name)
  const index = new Map(input.columns.map((name, i) => [name, i]))
  const statements: string[] = []
  const byRow = new Map<number, Record<string, unknown>>()

  for (const [key, value] of input.edits) {
    const [r, c] = key.split(':').map(Number)
    if (!Number.isInteger(r) || !Number.isInteger(c) || input.deleted.has(r)) continue
    const column = input.columns[c]
    if (!column) continue
    byRow.set(r, { ...byRow.get(r), [column]: value })
  }
  const keyOf = (r: number): RowKey => ({
    columns: input.primaryKey,
    values: input.primaryKey.map((c) => input.rows[r]?.[index.get(c) ?? -1]),
  })
  for (const [r, changes] of byRow) {
    if (Object.keys(changes).length) statements.push(buildUpdate(q, input.target, keyOf(r), changes, input.dialect))
  }
  for (const r of input.deleted) {
    if (input.rows[r]) statements.push(buildDelete(q, input.target, keyOf(r), input.dialect))
  }
  for (const row of input.inserted) {
    const values = Object.fromEntries(
      input.columns.map((name, i) => [name, row[i]]).filter(([, v]) => !isBlank(v)),
    )
    statements.push(buildInsert(q, input.target, values, input.dialect))
  }
  return statements
}
