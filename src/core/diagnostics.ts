/** Pure classification of connection failures and driver labels (shared by main and tests). */
import type {
  ConnectionConfig, ConnectionDiagnosis, ConnectionFailureCode, ConnectionTestStage, DriverKind,
} from '../shared/types'

interface Rule {
  code: ConnectionFailureCode
  stage: ConnectionTestStage
  hint: string
  match: RegExp
}

const HINTS: Record<ConnectionFailureCode, string> = {
  dns: 'Check the host name: this machine could not resolve it.',
  refused: 'Nothing is listening on that host and port. Check the port and that the server accepts remote connections.',
  unreachable: 'The host did not answer. Check the network, VPN or firewall between Stratum and the server.',
  timeout: 'The server did not answer in time. Raise Connect timeout in the Session tab or check the network.',
  tls: 'The TLS handshake failed. Check the server certificate, the CA bundle and whether SSL is required.',
  auth: 'The server rejected the credentials. Check the user and password; for MySQL also the allowed host.',
  database: 'The database or schema does not exist, or this user cannot see it.',
  driver: 'The JDBC driver could not be loaded. Install a matching driver JAR in Driver Manager.',
  file: 'The SQLite file cannot be opened. Check the path and its read/write permissions.',
  readonly: 'The server is read-only, or this data source is marked read-only.',
  bootstrap: 'The connection opened, but init SQL, default schema/catalog or isolation failed. Fix those values or enable "Ignore init errors".',
  tunnel: 'The SSH tunnel failed. Check the jump host, the key/passphrase and that the database is reachable from the jump host.',
  proxy: 'The proxy rejected the connection or could not reach the destination. Check its type, host, port and credentials.',
  invalid: 'Fill in the required connection fields before testing.',
  unknown: 'The connection failed. Check the server log for the matching entry.',
}

/** Rules run in order: the most specific driver messages win over broad words such as "timeout". */
const RULES: Rule[] = [
  { code: 'bootstrap', stage: 'bootstrap', hint: HINTS.bootstrap, match: /session setup failed|init(?:ialization)? sql|default (?:schema|catalog)|isolation level failed/i },
  { code: 'driver', stage: 'driver', hint: HINTS.driver, match: /no suitable driver|driver class|classnotfound|class not found|driver .*not found|could not load (?:driver|class)|missing driver|jdbc driver/i },
  { code: 'dns', stage: 'resolve', hint: HINTS.dns, match: /enotfound|eai_again|getaddrinfo|name or service not known|nodename nor servname|unknown host|host not found/i },
  { code: 'refused', stage: 'connect', hint: HINTS.refused, match: /econnrefused|connection refused|actively refused/i },
  { code: 'unreachable', stage: 'connect', hint: HINTS.unreachable, match: /ehostunreach|enetunreach|ehostdown|no route to host|network is unreachable/i },
  { code: 'timeout', stage: 'connect', hint: HINTS.timeout, match: /etimedout|timed? ?out|connection timeout|server selection timed? out|did not answer within|operation timeout/i },
  { code: 'tls', stage: 'tls', hint: HINTS.tls, match: /certificate|self[- ]signed|ssl|tls|handshake|verify (?:server|identity)|unknown ca/i },
  { code: 'auth', stage: 'auth', hint: HINTS.auth, match: /password authentication failed|authentication failed|access denied|invalid password|login failed|28p01|1045|ora-01017|authenticationexception|invalid credentials|not authorized/i },
  { code: 'database', stage: 'connect', hint: HINTS.database, match: /unknown database|database .* does not exist|3d000|1049|invalid catalog|unknown database name/i },
  { code: 'readonly', stage: 'connect', hint: HINTS.readonly, match: /read[- ]only|readonly/i },
  { code: 'file', stage: 'connect', hint: HINTS.file, match: /sqlite_cantopen|unable to open database|file is not a database|no such file or directory/i },
  { code: 'proxy', stage: 'proxy', hint: HINTS.proxy, match: /socks|http proxy|proxy connect|proxy refused|proxy authentication/i },
  { code: 'tunnel', stage: 'tunnel', hint: HINTS.tunnel, match: /ssh|jump host|tunnel|all configured authentication methods failed/i },
  { code: 'invalid', stage: 'config', hint: HINTS.invalid, match: /(?:required|missing|not set|must be set|choose|pick) .*(?:host|port|file|url|driver|database|path)|invalid (?:host|port|url|configuration)/i },
]

/**
 * Classify a driver/tunnel error. `stage` is what the caller already knows (for example that the
 * SSH helper failed before the database was contacted), so it wins over message guessing.
 */
export function classifyConnectionError(error: unknown, stage?: ConnectionTestStage): ConnectionDiagnosis {
  const message = (error instanceof Error ? error.message : String(error ?? '')).trim()
  if (stage === 'tunnel') return { code: 'tunnel', stage, hint: HINTS.tunnel }
  if (stage === 'proxy') return { code: 'proxy', stage, hint: HINTS.proxy }
  if (!message) return { code: 'unknown', stage: stage ?? 'unknown', hint: HINTS.unknown }
  for (const rule of RULES) {
    if (rule.match.test(message)) return { code: rule.code, stage: rule.stage, hint: rule.hint }
  }
  return { code: 'unknown', stage: stage ?? 'unknown', hint: HINTS.unknown }
}

const DRIVER: Record<DriverKind, string> = {
  postgres: 'pg',
  mysql: 'mysql2',
  sqlite: 'sql.js',
  jdbc: 'JDBC',
  mongodb: 'mongodb driver',
  redis: 'ioredis',
  elastic: 'HTTP client',
  cassandra: 'cassandra driver',
  s3: 'S3 client',
  ftp: 'FTP client',
  kafka: 'kafkajs',
  rabbitmq: 'Management API',
}

/** Short driver label for the test result. JDBC prefers the concrete class the user configured. */
export function driverLabel(config: Pick<ConnectionConfig, 'kind' | 'jdbc'>): string {
  if (config.kind === 'jdbc') {
    const name = config.jdbc?.driverClass?.trim()
    return name ? `JDBC · ${name.split('.').pop()}` : 'JDBC adapter'
  }
  return DRIVER[config.kind]
}
