/** DML generation for the data grid's "Submit" (pending edits -> SQL). Pure and dialect-parameterised. */
export type Quote = (identifier: string) => string

export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return `'${String(v).replace(/'/g, "''")}'`
}

export interface RowKey { columns: string[]; values: unknown[] }
const where = (q: Quote, k: RowKey) => k.columns.map((c, i) => (k.values[i] == null ? `${q(c)} IS NULL` : `${q(c)} = ${sqlLiteral(k.values[i])}`)).join(' AND ')

export function buildUpdate(q: Quote, table: string, key: RowKey, changes: Record<string, unknown>): string {
  const set = Object.entries(changes).map(([c, v]) => `${q(c)} = ${sqlLiteral(v)}`).join(', ')
  return `UPDATE ${table} SET ${set} WHERE ${where(q, key)}`
}
export const buildDelete = (q: Quote, table: string, key: RowKey) => `DELETE FROM ${table} WHERE ${where(q, key)}`
export function buildInsert(q: Quote, table: string, values: Record<string, unknown>): string {
  const cols = Object.keys(values)
  if (!cols.length) return `INSERT INTO ${table} DEFAULT VALUES`
  return `INSERT INTO ${table} (${cols.map(q).join(', ')}) VALUES (${cols.map((c) => sqlLiteral(values[c])).join(', ')})`
}
