/** Domain types shared by main, preload and renderer. No runtime dependencies. */

export type DriverKind = 'postgres' | 'mysql' | 'sqlite' | 'jdbc' | 'mongodb' | 'redis' | 'elastic' | 'cassandra' | 's3' | 'ftp' | 'kafka' | 'rabbitmq'
/**
 * SQL dialects Stratum can quote, complete and (through JDBC) target. The keyword and
 * function catalogs for each come from the installed DataGrip (see sqlDialectData.ts).
 */
export type DialectId =
  | 'postgres' | 'mysql' | 'mariadb' | 'sqlite' | 'mssql' | 'oracle' | 'db2' | 'derby' | 'h2' | 'hsql'
  | 'sybase' | 'vertica' | 'exasol' | 'greenplum' | 'redshift' | 'cockroach' | 'snowflake' | 'clickhouse'
  | 'bigquery' | 'hive' | 'spark' | 'cassandra' | 'generic'

/**
 * SSH tunnel helper ("connection helper" in DataGrip terms): Stratum opens one SSH connection to
 * this host and forwards a random local port to the data source's address, so every transport can
 * reach a server that is only visible from the SSH machine.
 */
export interface SshConfig {
  enabled: boolean
  host?: string
  port?: number
  user?: string
  /** `auto` offers password, private key and agent together, like DataGrip's default. */
  authType?: 'auto' | 'password' | 'privateKey' | 'agent'
  password?: string
  /** Private key file (PEM or OpenSSH); `~` expands to the home directory. */
  privateKeyPath?: string
  passphrase?: string
  /** Milliseconds allowed for the SSH handshake (default 10000). */
  connectTimeoutMs?: number
}

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
  /** Cassandra local data center (driver `localDataCenter`); defaults to `datacenter1`. */
  dataCenter?: string
  /** Cloud region (S3 and other regional services); defaults to `us-east-1`. */
  region?: string
  /** Unix socket to reach the server on (MySQL socket path, PostgreSQL socket directory); host is ignored while set. */
  socketPath?: string
  /** SQLite database file. */
  filePath?: string
  /** Generic JDBC (via jdbc-adapter-server). */
  jdbc?: { url: string; driverClass?: string; driverPath: string; dialect: DialectId }
  /** Connection URI for providers that take one (mongodb://…); overrides host/port/user/password when set. */
  uri?: string
  /** MongoDB auth database (defaults to `database`, then the driver default). */
  authSource?: string
  /** SSH tunnel helper; see SshConfig. Ignored by file databases (SQLite). */
  ssh?: SshConfig
  readonly?: boolean
  /** Folder label shown in the Database Explorer. */
  group?: string
}

/**
 * Connection metadata safe to send to the renderer. Secrets never cross the process boundary:
 * the UI only learns whether one is stored, and saving without a password preserves the old one.
 */
export interface ConnectionView extends Omit<ConnectionConfig, 'password' | 'ssh'> {
  password?: undefined
  ssh?: Omit<SshConfig, 'password' | 'passphrase'> & {
    password?: undefined
    passphrase?: undefined
    hasPassword: boolean
    hasPassphrase: boolean
  }
  hasPassword: boolean
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
export interface DatabaseModel { dialect: DialectId; version?: string; /** Provider the model came from; absent on older models (SQL assumed). */ kind?: DriverKind; schemas: SchemaInfo[] }

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
