import type { ConnectionConfig, DatabaseModel, DialectId } from './types'

/** SQL dialects Stratum offers for completion, quoting and JDBC presets, in menu order. */
export const DIALECTS: readonly { id: DialectId; label: string }[] = [
  { id: 'postgres', label: 'PostgreSQL' },
  { id: 'mysql', label: 'MySQL' },
  { id: 'mariadb', label: 'MariaDB' },
  { id: 'sqlite', label: 'SQLite' },
  { id: 'mssql', label: 'SQL Server (T-SQL)' },
  { id: 'oracle', label: 'Oracle' },
  { id: 'db2', label: 'IBM Db2' },
  { id: 'derby', label: 'Apache Derby' },
  { id: 'h2', label: 'H2' },
  { id: 'hsql', label: 'HSQLDB' },
  { id: 'sybase', label: 'SAP ASE (Sybase)' },
  { id: 'vertica', label: 'Vertica' },
  { id: 'exasol', label: 'Exasol' },
  { id: 'greenplum', label: 'Greenplum' },
  { id: 'redshift', label: 'Amazon Redshift' },
  { id: 'cockroach', label: 'CockroachDB' },
  { id: 'snowflake', label: 'Snowflake' },
  { id: 'clickhouse', label: 'ClickHouse' },
  { id: 'bigquery', label: 'BigQuery' },
  { id: 'hive', label: 'Apache Hive' },
  { id: 'spark', label: 'Spark SQL' },
  { id: 'cassandra', label: 'Cassandra (CQL)' },
  { id: 'generic', label: 'Generic SQL' },
]

export const dialectLabel = (id: DialectId): string => DIALECTS.find((d) => d.id === id)?.label ?? id

/** Effective SQL dialect of a connection: the introspected model wins over the configured preset. */
export function connectionDialect(c: ConnectionConfig | undefined, model?: DatabaseModel): DialectId {
  if (model?.dialect) return model.dialect
  if (!c) return 'generic'
  if (c.kind === 'postgres') return 'postgres'
  if (c.kind === 'mysql') return 'mysql'
  if (c.kind === 'sqlite') return 'sqlite'
  return c.jdbc?.dialect ?? 'generic'
}
