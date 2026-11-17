/** Domain types shared by main, preload and renderer. No runtime dependencies. */

export type DriverKind = 'postgres' | 'mysql' | 'sqlite' | 'jdbc' | 'mongodb' | 'redis' | 'elastic' | 'cassandra' | 's3' | 'ftp' | 'kafka' | 'rabbitmq'
/**
 * SQL dialects Stratum can quote, complete and (through JDBC) target. The keyword and
 * function catalogs for each come from the installed DataGrip (see sqlDialectData.ts).
 */
export type DialectId =
  | 'postgres' | 'mysql' | 'mariadb' | 'sqlite' | 'mssql' | 'oracle' | 'db2' | 'derby' | 'h2' | 'hsql'
  | 'sybase' | 'vertica' | 'exasol' | 'greenplum' | 'redshift' | 'cockroach' | 'snowflake' | 'clickhouse'
  | 'bigquery' | 'hive' | 'spark' | 'duckdb' | 'trino' | 'teradata' | 'firebird' | 'cassandra' | 'generic'

/** One intermediate SSH server in a jump chain. Credentials live only in the main process. */
export interface SshJumpHost {
  id: string
  host: string
  port?: number
  user: string
  authType?: 'auto' | 'password' | 'privateKey' | 'agent'
  password?: string
  privateKeyPath?: string
  passphrase?: string
}

/**
 * SSH tunnel helper ("connection helper" in DataGrip terms): Stratum opens one SSH connection to
 * this host and forwards a random local port to the data source's address, so every transport can
 * reach a server that is only visible from the SSH machine. `jumpHosts` are traversed in order
 * before the final host, like DataGrip's multi-hop connection helpers.
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
  /** Up to five intermediate hosts, traversed in order (DataGrip MAX_JUMP_SERVERS). */
  jumpHosts?: SshJumpHost[]
}

/** Color-coded safety profile, after DBeaver/DataGrip connection types. */
export type ConnectionProfile = 'dev' | 'test' | 'prod'
export type ConnectionColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'gray'
export type TransactionIsolation = 'default' | 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable'

/** Per-session behaviour applied every time the connection is opened (or re-opened). */
export interface SessionConfig {
  /** Statements executed right after connecting, separated by `;` (DataGrip's "keep-alive/init SQL"). */
  initSql?: string
  /** Default schema (search_path on PostgreSQL, current schema elsewhere). */
  defaultSchema?: string
  /** Default catalog/database (USE on MySQL, setCatalog where the driver supports it). */
  defaultCatalog?: string
  /** When false the first statement opens a transaction that must be committed explicitly. */
  autoCommit?: boolean
  isolation?: TransactionIsolation
  /** Ping an idle session after this many seconds (0 disables it). */
  keepAliveSeconds?: number
  /** Close an idle session after this many seconds (0 keeps it open). Never closes an open transaction. */
  idleTimeoutSeconds?: number
  /** Milliseconds allowed to establish the socket/connection; the driver default applies when absent. */
  connectTimeoutMs?: number
  /** Milliseconds allowed for one keep-alive validation round trip (default 15000). */
  validationTimeoutMs?: number
  /** Keep the session usable when init SQL, default schema/catalog or isolation fails. */
  ignoreInitErrors?: boolean
}

/** Where a connection attempt failed; shown next to the human-readable error. */
export type ConnectionTestStage =
  | 'config' | 'resolve' | 'connect' | 'tls' | 'auth' | 'bootstrap' | 'driver' | 'tunnel' | 'proxy' | 'unknown'

/** Stable failure category, independent of the driver that produced the message. */
export type ConnectionFailureCode =
  | 'dns' | 'refused' | 'unreachable' | 'timeout' | 'tls' | 'auth' | 'database' | 'driver'
  | 'file' | 'readonly' | 'bootstrap' | 'tunnel' | 'proxy' | 'invalid' | 'unknown'

/** Structured diagnosis for a failed connection attempt. */
export interface ConnectionDiagnosis {
  code: ConnectionFailureCode
  stage: ConnectionTestStage
  /** One actionable sentence for the dialog status line. */
  hint: string
}

/** Result of "Test Connection": enough detail to fix the problem without reading a driver stack. */
export interface ConnectionTestResult {
  ok: boolean
  /** Wall-clock duration of the attempt, including the tunnel and session setup. */
  latencyMs: number
  version?: string
  /** Driver or adapter that handled the attempt (pg, mysql2, JDBC class…). */
  driver?: string
  code?: ConnectionFailureCode
  stage?: ConnectionTestStage
  error?: string
  hint?: string
}

/** SOCKS5 or HTTP CONNECT proxy used as a connection helper for network databases. */
export interface ProxyConfig {
  enabled: boolean
  type: 'socks5' | 'http'
  host?: string
  port?: number
  user?: string
  password?: string
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
  /** Verify the server certificate and hostname (opt-in; off keeps the legacy "encrypt only" behaviour). */
  sslVerify?: boolean
  /** PEM CA bundle; empty uses the OS trust store. */
  sslCaPath?: string
  /** Client certificate and private key for mutual TLS. */
  sslClientCertPath?: string
  sslClientKeyPath?: string
  /** Passphrase protecting the client key (sealed in the connection store). */
  sslKeyPassphrase?: string
  /** Safety profile (color + confirmation defaults) shown in the explorer. */
  profile?: ConnectionProfile
  /** Override the profile color with an explicit swatch. */
  color?: ConnectionColor
  /** Ask before every write statement, including grid Submit. */
  confirmWrites?: boolean
  /** Session lifecycle: init SQL, defaults, auto-commit, isolation, keep-alive and idle close. */
  session?: SessionConfig
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
  /** SQL variables expanded in `${name}` / `$(name)` before execution; override the global values. */
  variables?: Record<string, string>
  /** Connection URI for providers that take one (mongodb://…); overrides host/port/user/password when set. */
  uri?: string
  /** MongoDB auth database (defaults to `database`, then the driver default). */
  authSource?: string
  /** SSH tunnel helper; see SshConfig. Ignored by file databases (SQLite). */
  ssh?: SshConfig
  /** SOCKS5/HTTP CONNECT proxy helper; mutually exclusive with `ssh` in this build. */
  proxy?: ProxyConfig
  readonly?: boolean
  /** Folder label shown in the Database Explorer. */
  group?: string
}

/** SSH jump host metadata safe for the renderer. */
export interface SshJumpHostView extends Omit<SshJumpHost, 'password' | 'passphrase'> {
  password?: undefined
  passphrase?: undefined
  hasPassword: boolean
  hasPassphrase: boolean
}

/**
 * Connection metadata safe to send to the renderer. Secrets never cross the process boundary:
 * the UI only learns whether one is stored, and saving without a password preserves the old one.
 */
export interface ConnectionView extends Omit<ConnectionConfig, 'password' | 'ssh' | 'sslKeyPassphrase' | 'proxy'> {
  password?: undefined
  sslKeyPassphrase?: undefined
  ssh?: Omit<SshConfig, 'password' | 'passphrase' | 'jumpHosts'> & {
    password?: undefined
    passphrase?: undefined
    hasPassword: boolean
    hasPassphrase: boolean
    jumpHosts?: SshJumpHostView[]
  }
  proxy?: Omit<ProxyConfig, 'password'> & { password?: undefined; hasPassword: boolean }
  hasPassword: boolean
  hasSslKeyPassphrase: boolean
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
  /** At least one binary value was shortened for display; "All rows" can fetch it in full. */
  truncatedBinary?: boolean
  error?: string
}

/* ------------------------------------------------------------------ PL/pgSQL debugger */

/** One argument of a routine as PostgreSQL reports it. */
export interface DebugRoutineArgument {
  /** Parameter name, or `arg1`, `arg2`… when the routine does not name it. */
  name: string
  /** Canonical SQL type (`integer`, `character varying`, `public.my_type`). */
  type: string
  /** Trailing input parameter with a DEFAULT: it may be left empty. */
  optional: boolean
}

/** A debuggable PostgreSQL routine (PL/pgSQL function or procedure). */
export interface DebugRoutine {
  oid: number
  schema: string
  name: string
  kind: 'function' | 'procedure'
  language: string
  /** Human-readable input signature, e.g. `(id integer, name text)`. */
  signature: string
  returnType: string
  returnsSet: boolean
  /** VARIADIC input: the generated call would need an ARRAY[...] expression. */
  variadic: boolean
  arguments: DebugRoutineArgument[]
}

/** Where the target is stopped after a breakpoint or a step. */
export interface DebugBreakpoint {
  oid: number
  /** 1-based line inside the routine body; a negative value means "at the entry". */
  line: number
  target?: string
}

/** One PL/pgSQL call-stack frame, deepest first (`level` 0 is the current one). */
export interface DebugFrame {
  level: number
  name: string
  oid: number
  line: number
  args: string
}

/** One local variable or parameter of the focused frame. */
export interface DebugVariable {
  name: string
  /** Declaration line in the routine body (0 when not reported). */
  line: number
  unique: boolean
  constant: boolean
  notNull: boolean
  typeOid: number
  /** Formatted type name; falls back to `oid N` when the catalog lookup fails. */
  type: string
  value: string | null
}

/** Source body of the function currently shown. */
export interface DebugSource {
  oid: number
  schema: string
  name: string
  text: string
}

/** Outcome of the target invocation (only the first rows are kept for the panel). */
export interface DebugResult {
  sql: string
  durationMs: number
  columns: ColumnMeta[]
  rows: unknown[][]
  /** More rows were returned than the debugger kept. */
  truncated: boolean
  error?: string
}

export type DebugStatus = 'paused' | 'running' | 'finished' | 'failed' | 'stopped'

/** Everything the debug tab needs after a start or a step command. */
export interface DebugSnapshot {
  id: string
  status: DebugStatus
  routine: DebugRoutine
  breakpoint?: DebugBreakpoint
  frames: DebugFrame[]
  /** Level of the frame whose variables and source are shown. */
  selectedFrame: number
  source?: DebugSource
  variables: DebugVariable[]
  /** Breakpoints registered on the target, mirrored for the gutter. */
  breakpoints: DebugBreakpoint[]
  result?: DebugResult
  error?: string
}

/** Whether the pldebugger proxy is installed in this database. */
export interface DebugProbe {
  available: boolean
  serverVersion?: string
  proxyApiVersion?: number
  error?: string
  hint?: string
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

/** Live transaction state pushed to the console after every statement. */
export interface TransactionState {
  open: boolean
  /** Effective setting for this session (false means statements accumulate until commit). */
  autoCommit: boolean
  /** Epoch milliseconds when the current transaction started. */
  since?: number
  /** True when the driver reported that the transaction can only be rolled back. */
  failed?: boolean
  /** Savepoints created from the toolbar, in creation order (advisory; the server owns the real list). */
  savepoints?: string[]
}

/** One node of an execution plan, normalized across PostgreSQL, MySQL and SQLite. */
export interface PlanNode {
  label: string
  detail?: string
  /** Estimated rows / cost, when the database exposes them. */
  rows?: number
  cost?: number
  actualRows?: number
  actualTimeMs?: number
  /** Actionable warning, e.g. a sequential scan or a filesort. */
  warning?: string
  children?: PlanNode[]
}

export interface QueryPlan {
  dialect: DialectId
  format: 'json' | 'text'
  sql: string
  root: PlanNode
  raw?: string
  durationMs: number
  error?: string
}

/** One row of the server session/lock monitor. */
export interface SessionInfo {
  pid: number | string
  user?: string
  database?: string
  client?: string
  state?: string
  query?: string
  startedAt?: string
  /** Seconds the session has been in its current state (MySQL `time`). */
  seconds?: number
  wait?: string
  /** Other server PIDs blocking this one (PostgreSQL). */
  blockedBy?: number[]
  current?: boolean
}

/** A live session changed outside a renderer action (idle close or a failed keep-alive). */
export interface SessionStateChange {
  id: string
  status: 'closed' | 'lost'
  reason?: string
}

/** A named SQL statement from the saved-query library. */
export interface SavedQuery {
  id: string
  name: string
  sql: string
  connectionId?: string
  createdAt: number
  updatedAt: number
}

/** Selection passed to the ERD builder; part of the renderer-to-store contract. */
export interface ErdOptions {
  schemas?: string[]
  tables?: string[]
  includeViews?: boolean
  /** Only these tables plus FK neighbours up to `depth`. */
  focus?: { table: string; depth: number }
}

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
