import type { DialectId } from '../shared/types'

/** Dialects that quote identifiers with backticks (MySQL family, ClickHouse, Hive/Spark, BigQuery). */
const BACKTICK = new Set<DialectId>(['mysql', 'mariadb', 'clickhouse', 'bigquery', 'hive', 'spark'])

/** Identifier quoting, shared by the main-process dialects and the renderer's data editor. */
export function quote(d: DialectId, id: string): string {
  if (BACKTICK.has(d)) return `\`${id.replace(/`/g, '``')}\``
  if (d === 'mssql') return `[${id.replace(/]/g, ']]')}]`
  return `"${id.replace(/"/g, '""')}"`
}
export const qualify = (d: DialectId, schema: string | undefined, table: string) =>
  schema && d !== 'sqlite' ? `${quote(d, schema)}.${quote(d, table)}` : quote(d, table)
