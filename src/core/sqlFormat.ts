/** Dialect-aware SQL formatting for the console (sql-formatter, MIT). */
import { format, type SqlLanguage } from 'sql-formatter'
import type { DialectId } from '../shared/types'
import type { KeywordCase } from './settings'

/**
 * Map Stratum's provider dialects to sql-formatter languages. Generic/embedded engines use the
 * neutral `sql` grammar; the T-SQL family shares `transactsql`.
 */
const LANGUAGE: Record<DialectId, SqlLanguage> = {
  postgres: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  sqlite: 'sqlite',
  mssql: 'transactsql',
  oracle: 'plsql',
  db2: 'db2',
  derby: 'sql',
  h2: 'sql',
  hsql: 'sql',
  sybase: 'transactsql',
  vertica: 'postgresql',
  exasol: 'sql',
  greenplum: 'postgresql',
  redshift: 'redshift',
  cockroach: 'postgresql',
  snowflake: 'snowflake',
  clickhouse: 'clickhouse',
  bigquery: 'bigquery',
  hive: 'hive',
  spark: 'spark',
  cassandra: 'sql',
  generic: 'sql',
}

/**
 * Format a SQL fragment. Throws with the formatter's message when the text cannot be parsed; the
 * console keeps the original text and shows the message instead of corrupting the buffer.
 */
export function formatSql(text: string, dialect: DialectId, options: { keywordCase?: KeywordCase; tabWidth?: number } = {}): string {
  if (!text.trim()) return text
  return format(text, {
    language: LANGUAGE[dialect] ?? 'sql',
    keywordCase: options.keywordCase ?? 'upper',
    tabWidth: Math.min(8, Math.max(1, Math.round(options.tabWidth ?? 2))),
    linesBetweenQueries: 2,
  })
}
