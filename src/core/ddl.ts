/** DDL for the table designer and INSERT batches for the data import. Pure and dialect-parameterised. */
import type { DialectId } from '../shared/types'
import { qualify, quote } from './quoting'
import { literalFor } from './sqlgen'

export interface DesignerColumn {
  name: string
  /** Type expression copied verbatim, e.g. `varchar(255)` or `timestamp with time zone`. */
  type: string
  nullable: boolean
  primaryKey: boolean
  unique?: boolean
  /** SQL expression appended verbatim after DEFAULT (e.g. `now()`, `0`, `'x'`). */
  default?: string
}

export interface DesignerTable {
  schema?: string
  name: string
  columns: DesignerColumn[]
}

const SUGGESTIONS: Partial<Record<DialectId, string[]>> = {
  postgres: ['text', 'integer', 'bigint', 'boolean', 'numeric(12,2)', 'timestamp', 'timestamptz', 'date', 'uuid', 'jsonb', 'bytea'],
  mysql: ['varchar(255)', 'text', 'int', 'bigint', 'tinyint(1)', 'decimal(12,2)', 'datetime', 'date', 'json', 'blob'],
  mariadb: ['varchar(255)', 'text', 'int', 'bigint', 'tinyint(1)', 'decimal(12,2)', 'datetime', 'date', 'json', 'blob'],
  sqlite: ['text', 'integer', 'real', 'numeric', 'blob'],
  mssql: ['nvarchar(255)', 'int', 'bigint', 'bit', 'decimal(12,2)', 'datetime2', 'date', 'uniqueidentifier', 'varbinary(max)'],
  oracle: ['varchar2(255)', 'number', 'number(1)', 'date', 'timestamp', 'clob', 'blob'],
}

const GENERIC = ['text', 'integer', 'bigint', 'boolean', 'numeric(12,2)', 'timestamp', 'date', 'json']

/** Column types offered for a dialect (free text is always accepted too). */
export const columnTypes = (dialect: DialectId): string[] => SUGGESTIONS[dialect] ?? GENERIC

/** A string column for the new table a CSV import creates (dialect-specific, since `text` is not universal). */
const TEXT_TYPES: Partial<Record<DialectId, string>> = {
  mssql: 'nvarchar(255)', oracle: 'varchar2(255)', db2: 'varchar(255)', sybase: 'varchar(255)', derby: 'varchar(255)',
}
export const textColumnType = (dialect: DialectId): string => TEXT_TYPES[dialect] ?? 'text'

/** Throws when the designer cannot build a statement; the caller surfaces the message. */
function validate(t: DesignerTable): void {
  if (!t.name.trim()) throw new Error('Table name is required')
  if (!t.columns.length) throw new Error('Add at least one column')
  const seen = new Set<string>()
  for (const c of t.columns) {
    const name = c.name.trim()
    if (!name) throw new Error('Every column needs a name')
    if (seen.has(name.toLowerCase())) throw new Error(`Duplicate column: ${name}`)
    seen.add(name.toLowerCase())
    if (!c.type.trim()) throw new Error(`Column ${name} needs a type`)
  }
}

/**
 * `CREATE TABLE` for the designer. The primary key is emitted as a table constraint, which keeps
 * composite keys valid everywhere; defaults and types are copied verbatim, so a dialect-specific
 * expression such as `now()` works without a type table.
 */
export function createTableSql(dialect: DialectId, t: DesignerTable): string {
  validate(t)
  const lines = t.columns.map((c) => {
    const parts = [quote(dialect, c.name.trim()), c.type.trim()]
    if (!c.nullable) parts.push('not null')
    if (c.unique) parts.push('unique')
    if (c.default?.trim()) parts.push(`default ${c.default.trim()}`)
    return `  ${parts.join(' ')}`
  })
  const pk = t.columns.filter((c) => c.primaryKey).map((c) => quote(dialect, c.name.trim()))
  if (pk.length) lines.push(`  primary key (${pk.join(', ')})`)
  return `create table ${qualify(dialect, t.schema?.trim() || undefined, t.name.trim())} (\n${lines.join(',\n')}\n);`
}

/**
 * Multi-row INSERT statements, split in batches so a large CSV does not exceed driver or server
 * statement limits. Cells are string|null; empty cells are inserted as the empty string, not NULL.
 */
export function buildInsertStatements(
  dialect: DialectId,
  table: { schema?: string; name: string },
  columns: string[],
  rows: (string | null)[][],
  batchSize = 500,
): string[] {
  if (!rows.length) return []
  if (!columns.length) throw new Error('The target table has no columns')
  const target = qualify(dialect, table.schema?.trim() || undefined, table.name.trim())
  const cols = columns.map((c) => quote(dialect, c)).join(', ')
  const lit = literalFor(dialect)
  const size = Math.max(1, Math.floor(batchSize))
  const out: string[] = []
  for (let i = 0; i < rows.length; i += size) {
    const values = rows.slice(i, i + size).map((r) => `(${columns.map((_c, j) => lit(r[j] ?? null)).join(', ')})`)
    out.push(`insert into ${target} (${cols}) values\n${values.join(',\n')};`)
  }
  return out
}
