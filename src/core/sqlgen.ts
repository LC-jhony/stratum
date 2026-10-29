/** DML generation for the data grid's "Submit" (pending edits -> SQL). Pure and dialect-parameterised. */
import type { DialectId } from '../shared/types'

export type Quote = (identifier: string) => string

/** Dialects where a backslash starts an escape sequence inside a string literal. */
const BACKSLASH_ESCAPES = new Set<DialectId>(['mysql', 'mariadb', 'clickhouse', 'hive', 'spark', 'bigquery'])

/** A literal renderer for one dialect: backslashes are doubled only where the engine treats them as escapes. */
export function literalFor(dialect: DialectId = 'generic'): (v: unknown) => string {
  const escapeBackslash = BACKSLASH_ESCAPES.has(dialect)
  return (v: unknown): string => {
    if (v === null || v === undefined) return 'NULL'
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
    let s = String(v)
    if (escapeBackslash) s = s.replace(/\\/g, '\\\\')
    return `'${s.replace(/'/g, "''")}'`
  }
}

/** Backwards-compatible alias with the generic (ANSI) escaping rules. */
export function sqlLiteral(v: unknown, dialect: DialectId = 'generic'): string { return literalFor(dialect)(v) }

export interface RowKey { columns: string[]; values: unknown[] }
const where = (q: Quote, k: RowKey, lit: (v: unknown) => string) =>
  k.columns.map((c, i) => (k.values[i] == null ? `${q(c)} IS NULL` : `${q(c)} = ${lit(k.values[i])}`)).join(' AND ')

export function buildUpdate(q: Quote, table: string, key: RowKey, changes: Record<string, unknown>, dialect: DialectId = 'generic'): string {
  const lit = literalFor(dialect)
  const set = Object.entries(changes).map(([c, v]) => `${q(c)} = ${lit(v)}`).join(', ')
  return `UPDATE ${table} SET ${set} WHERE ${where(q, key, lit)}`
}
export const buildDelete = (q: Quote, table: string, key: RowKey, dialect: DialectId = 'generic') =>
  `DELETE FROM ${table} WHERE ${where(q, key, literalFor(dialect))}`
export function buildInsert(q: Quote, table: string, values: Record<string, unknown>, dialect: DialectId = 'generic'): string {
  const lit = literalFor(dialect)
  const cols = Object.keys(values)
  if (!cols.length) return `INSERT INTO ${table} DEFAULT VALUES`
  return `INSERT INTO ${table} (${cols.map(q).join(', ')}) VALUES (${cols.map((c) => lit(values[c])).join(', ')})`
}
