/** Domain types shared by main, preload and renderer. No runtime dependencies. */

export type DriverKind = 'postgres' | 'mysql' | 'sqlite' | 'jdbc'
/**
 * SQL dialects Stratum can quote, complete and (through JDBC) target. The keyword and
 * function catalogs for each come from the installed DataGrip (see sqlDialectData.ts).
 */
export type DialectId =
  | 'postgres' | 'mysql' | 'mariadb' | 'sqlite' | 'mssql' | 'oracle' | 'db2' | 'derby' | 'h2' | 'hsql'
  | 'sybase' | 'vertica' | 'exasol' | 'greenplum' | 'redshift' | 'cockroach' | 'snowflake' | 'clickhouse'
  | 'bigquery' | 'hive' | 'spark' | 'cassandra' | 'generic'

export interface ConnectionConfig {
  id: string
  name: string
  kind: DriverKind
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  ssl?: boolean
  /** SQLite database file. */
  filePath?: string
  /** Generic JDBC (via jdbc-adapter-server). */
  jdbc?: { url: string; driverClass?: string; driverPath: string; dialect: DialectId }
  readonly?: boolean
  /** Folder label shown in the Database Explorer. */
  group?: string
}

export interface ColumnMeta { name: string; type?: string; table?: string }

export interface RawResult {
  columns: ColumnMeta[]
  rows: unknown[][]
  affectedRows?: number
}

export interface QueryResult extends RawResult {
  sql: string
  durationMs: number
  /** True when more rows exist beyond `rows` (DataGrip-style paged fetch). */
  hasMore: boolean
  offset: number
  error?: string
}

export interface ColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  default?: string | null
  isPrimaryKey: boolean
  ordinal: number
}
export interface ForeignKey {
  name: string
  columns: string[]
  refSchema: string
  refTable: string
  refColumns: string[]
}
export interface IndexInfo { name: string; columns: string[]; unique: boolean }
export interface TableInfo {
  name: string
  kind: 'table' | 'view'
  columns: ColumnInfo[]
  foreignKeys: ForeignKey[]
  indexes: IndexInfo[]
}
export interface SchemaInfo { name: string; tables: TableInfo[] }
export interface DatabaseModel { dialect: DialectId; version?: string; schemas: SchemaInfo[] }

/** Theme payloads delivered to the renderer, already parsed from JSONC. */
export interface ThemeManifestEntry {
  id: string
  label: string
  kind: 'color' | 'fileIcon' | 'productIcon'
  uiTheme?: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light'
  /** Absolute path of the JSON file (main-process resolved). */
  path: string
  source: 'builtin' | 'user' | 'vscode-extension'
}
export interface ThemeFile { entry: ThemeManifestEntry; json: unknown; /** Directory used to resolve relative asset paths. */ baseUrl: string }
