/**
 * Declarative JDBC engine presets. The generic JDBC transport already reaches any driver; this
 * table only adds the URL shape, default port, driver-class hint and SQL dialect for engines that
 * do not deserve a dedicated transport. Adding an engine is one row plus its dialect, not a new
 * plugin: the dialog and the driver manager both read this list.
 */
import type { DialectId } from '../shared/types'

export interface EnginePreset {
  id: string
  label: string
  dialect: DialectId
  /** JDBC URL template with the host/port a user normally edits. */
  url: string
  /** Default port shown by the dialog; embedded engines leave it undefined. */
  port?: number
  /** Class name pre-filled when the driver JAR is a single known implementation. */
  driverClass?: string
}

export const ENGINE_PRESETS: readonly EnginePreset[] = [
  { id: 'h2', label: 'H2', dialect: 'h2', url: 'jdbc:h2:tcp://localhost/~/stratum', port: 9092, driverClass: 'org.h2.Driver' },
  { id: 'duckdb', label: 'DuckDB', dialect: 'duckdb', url: 'jdbc:duckdb:stratum.duckdb', driverClass: 'org.duckdb.DuckDBDriver' },
  { id: 'snowflake', label: 'Snowflake', dialect: 'snowflake', url: 'jdbc:snowflake://account.snowflakecomputing.com/?db=DB&warehouse=WAREHOUSE', port: 443, driverClass: 'net.snowflake.client.jdbc.SnowflakeDriver' },
  { id: 'bigquery', label: 'BigQuery', dialect: 'bigquery', url: 'jdbc:bigquery://https://www.googleapis.com/bigquery/v2:443;ProjectId=PROJECT;DefaultDataset=DATASET', driverClass: 'com.simba.googlebigquery.jdbc.Driver' },
  { id: 'redshift', label: 'Amazon Redshift', dialect: 'redshift', url: 'jdbc:redshift://localhost:5439/dev', port: 5439, driverClass: 'com.amazon.redshift.jdbc.Driver' },
  { id: 'trino', label: 'Trino', dialect: 'trino', url: 'jdbc:trino://localhost:8080/catalog/schema', port: 8080, driverClass: 'io.trino.jdbc.TrinoDriver' },
  { id: 'vertica', label: 'Vertica', dialect: 'vertica', url: 'jdbc:vertica://localhost:5433/database', port: 5433, driverClass: 'com.vertica.jdbc.Driver' },
  { id: 'teradata', label: 'Teradata', dialect: 'teradata', url: 'jdbc:teradata://localhost/DATABASE=db', port: 1025, driverClass: 'com.teradata.jdbc.TeraDriver' },
  { id: 'hsqldb', label: 'HSQLDB', dialect: 'hsql', url: 'jdbc:hsqldb:hsql://localhost:9001/db', port: 9001, driverClass: 'org.hsqldb.jdbc.JDBCDriver' },
  { id: 'derby', label: 'Apache Derby', dialect: 'derby', url: 'jdbc:derby://localhost:1527/db;create=false', port: 1527, driverClass: 'org.apache.derby.jdbc.ClientDriver' },
  { id: 'firebird', label: 'Firebird', dialect: 'firebird', url: 'jdbc:firebirdsql://localhost:3050//path/database.fdb', port: 3050, driverClass: 'org.firebirdsql.jdbc.FBDriver' },
  { id: 'greenplum', label: 'Greenplum', dialect: 'greenplum', url: 'jdbc:postgresql://localhost:5432/db', port: 5432, driverClass: 'org.postgresql.Driver' },
  { id: 'cockroach', label: 'CockroachDB', dialect: 'cockroach', url: 'jdbc:postgresql://localhost:26257/defaultdb', port: 26257, driverClass: 'org.postgresql.Driver' },
  { id: 'exasol', label: 'Exasol', dialect: 'exasol', url: 'jdbc:exa:localhost:8563', port: 8563, driverClass: 'com.exasol.jdbc.EXADriver' },
  { id: 'sybase', label: 'SAP ASE (Sybase)', dialect: 'sybase', url: 'jdbc:sybase:Tds:localhost:5000/db', port: 5000, driverClass: 'net.sourceforge.jtds.jdbc.Driver' },
  { id: 'hive', label: 'Apache Hive', dialect: 'hive', url: 'jdbc:hive2://localhost:10000/default', port: 10000, driverClass: 'org.apache.hive.jdbc.HiveDriver' },
  { id: 'spark', label: 'Spark SQL', dialect: 'spark', url: 'jdbc:hive2://localhost:10000/default', port: 10000, driverClass: 'org.apache.hive.jdbc.HiveDriver' },
]

/** Preset shown for a JDBC dialect, or undefined when the connection uses a hand-written URL. */
export const enginePreset = (dialect: DialectId | undefined): EnginePreset | undefined =>
  ENGINE_PRESETS.find((e) => e.dialect === dialect)

/** The URL to prefill when switching engine: the preset wins over a URL typed for another engine. */
export function urlForEngine(previous: { url?: string; dialect?: DialectId } | undefined, next: EnginePreset, fallback = 'jdbc:'): string {
  if (!previous?.url) return next.url
  if (previous.dialect && previous.dialect !== next.dialect) return next.url
  return previous.url || fallback
}
