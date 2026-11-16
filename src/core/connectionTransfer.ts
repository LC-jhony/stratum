/**
 * Portable connection export/import.
 *
 * An export is a plain JSON document with the safe half of every connection: host, port, user,
 * database, SSH topology (paths, not credentials), session policy and JDBC settings. Passwords,
 * passphrases and stored-secret flags never leave the machine. Import validates every field and
 * assigns fresh ids, so a file cannot overwrite an existing data source.
 */
import type {
  ConnectionColor, ConnectionConfig, ConnectionProfile, DialectId, DriverKind, ProxyConfig, SessionConfig, SshConfig, SshJumpHost,
  TransactionIsolation,
} from '../shared/types'
import { DIALECTS } from './dialects'
import { KINDS } from './kinds'

export const CONNECTION_EXPORT_FORMAT = 'stratum.connections'
export const CONNECTION_EXPORT_VERSION = 1
/** Upper bound for one file; a hand-edited file should never be able to stall the main process. */
const MAX_IMPORTED = 5000

const KINDS_SET = new Set<string>(Object.keys(KINDS))
const DIALECT_SET = new Set<string>(DIALECTS.map((d) => d.id))
const PROFILE_SET = new Set<string>(['dev', 'test', 'prod'])
const COLOR_SET = new Set<string>(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'])
const ISOLATION_SET = new Set<string>(['default', 'read uncommitted', 'read committed', 'repeatable read', 'serializable'])
const AUTH_SET = new Set<string>(['auto', 'password', 'privateKey', 'agent'])

const text = (v: unknown, max = 4000): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)
const nonEmpty = (v: unknown, max = 4000): string | undefined => {
  const s = text(v, max)?.trim()
  return s ? s : undefined
}
const flag = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
const int = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined

const stringMap = (v: unknown): Record<string, string> | undefined => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(v as Record<string, unknown>).slice(0, 500)) {
    const name = key.trim().slice(0, 200)
    if (name && typeof value === 'string') out[name] = value.slice(0, 100_000)
  }
  return Object.keys(out).length ? out : undefined
}

function cleanSession(v: unknown): SessionConfig | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const raw = v as Record<string, unknown>
  const out: SessionConfig = {}
  const initSql = text(raw.initSql, 100_000)
  if (initSql !== undefined) out.initSql = initSql
  const defaultSchema = nonEmpty(raw.defaultSchema, 500)
  if (defaultSchema) out.defaultSchema = defaultSchema
  const defaultCatalog = nonEmpty(raw.defaultCatalog, 500)
  if (defaultCatalog) out.defaultCatalog = defaultCatalog
  const autoCommit = flag(raw.autoCommit)
  if (autoCommit !== undefined) out.autoCommit = autoCommit
  if (typeof raw.isolation === 'string' && ISOLATION_SET.has(raw.isolation)) out.isolation = raw.isolation as TransactionIsolation
  const keepAliveSeconds = int(raw.keepAliveSeconds, 0, 86_400)
  if (keepAliveSeconds !== undefined) out.keepAliveSeconds = keepAliveSeconds
  const idleTimeoutSeconds = int(raw.idleTimeoutSeconds, 0, 604_800)
  if (idleTimeoutSeconds !== undefined) out.idleTimeoutSeconds = idleTimeoutSeconds
  return Object.keys(out).length ? out : undefined
}

function cleanJumpHost(v: unknown, index: number): SshJumpHost | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const raw = v as Record<string, unknown>
  const host = nonEmpty(raw.host, 2000)
  const user = nonEmpty(raw.user, 2000)
  if (!host || !user) return undefined
  const out: SshJumpHost = { id: nonEmpty(raw.id, 200) ?? `jump-${index + 1}`, host, user }
  const port = int(raw.port, 1, 65_535)
  if (port !== undefined) out.port = port
  if (typeof raw.authType === 'string' && AUTH_SET.has(raw.authType)) out.authType = raw.authType as SshJumpHost['authType']
  const privateKeyPath = nonEmpty(raw.privateKeyPath, 4000)
  if (privateKeyPath) out.privateKeyPath = privateKeyPath
  return out
}

function cleanSsh(v: unknown): SshConfig | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const raw = v as Record<string, unknown>
  const enabled = raw.enabled === true
  // A disabled tunnel still carries the host and keys the user configured; keep them.
  const meaningful = enabled || [raw.host, raw.user, raw.privateKeyPath].some((x) => typeof x === 'string' && x.trim())
  if (!meaningful) return undefined
  const out: SshConfig = { enabled }
  const host = nonEmpty(raw.host, 2000)
  if (host) out.host = host
  const port = int(raw.port, 1, 65_535)
  if (port !== undefined) out.port = port
  const user = nonEmpty(raw.user, 2000)
  if (user) out.user = user
  if (typeof raw.authType === 'string' && AUTH_SET.has(raw.authType)) out.authType = raw.authType as SshConfig['authType']
  const privateKeyPath = nonEmpty(raw.privateKeyPath, 4000)
  if (privateKeyPath) out.privateKeyPath = privateKeyPath
  const connectTimeoutMs = int(raw.connectTimeoutMs, 1, 120_000)
  if (connectTimeoutMs !== undefined) out.connectTimeoutMs = connectTimeoutMs
  if (Array.isArray(raw.jumpHosts)) {
    const seen = new Set<string>()
    const jumps: SshJumpHost[] = []
    for (const [i, entry] of raw.jumpHosts.slice(0, 5).entries()) {
      const jump = cleanJumpHost(entry, i)
      if (!jump) continue
      if (seen.has(jump.id)) jump.id = `${jump.id}-${i + 1}`
      seen.add(jump.id)
      jumps.push(jump)
    }
    if (jumps.length) out.jumpHosts = jumps
  }
  return out
}

/** Proxy fields travel, the proxy password never does: the importer starts without one. */
function cleanProxy(v: unknown): ProxyConfig | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const raw = v as Record<string, unknown>
  if (raw.type !== 'socks5' && raw.type !== 'http') return undefined
  const enabled = raw.enabled === true
  const host = nonEmpty(raw.host, 2000)
  // A disabled proxy still records type/host/port so re-enabling it needs no retyping.
  if (!enabled && !host) return undefined
  const out: ProxyConfig = { enabled, type: raw.type }
  if (host) out.host = host
  const port = int(raw.port, 1, 65_535)
  if (port !== undefined) out.port = port
  const user = nonEmpty(raw.user, 2000)
  if (user) out.user = user
  return out
}

function cleanJdbc(v: unknown): ConnectionConfig['jdbc'] | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const raw = v as Record<string, unknown>
  const url = nonEmpty(raw.url, 4000)
  if (!url) return undefined
  const dialect = typeof raw.dialect === 'string' && DIALECT_SET.has(raw.dialect) ? (raw.dialect as DialectId) : 'generic'
  const out: NonNullable<ConnectionConfig['jdbc']> = { url, driverPath: nonEmpty(raw.driverPath, 4000) ?? '', dialect }
  const driverClass = nonEmpty(raw.driverClass, 500)
  if (driverClass) out.driverClass = driverClass
  return out
}

/** Name shown when the file has none: a data source is unusable without a label in the explorer. */
function fallbackName(raw: Record<string, unknown>): string {
  const jdbcUrl = raw.jdbc && typeof raw.jdbc === 'object' ? (raw.jdbc as { url?: unknown }).url : undefined
  const candidates = [raw.database, raw.host, raw.uri, raw.filePath, jdbcUrl, raw.kind]
  for (const value of candidates) {
    if (typeof value !== 'string' || !value.trim()) continue
    const base = value.trim().split(/[\\/]/).pop() ?? value.trim()
    return base.slice(0, 200)
  }
  return 'Imported data source'
}

/**
 * Build a clean `ConnectionConfig` from untrusted input. Every allowed field is copied explicitly,
 * which both strips secrets (password, passphrases, `has*` flags) and drops unknown properties.
 */
export function sanitizeConnection(input: unknown, index = 0): { connection?: ConnectionConfig; problems: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { problems: [`Entry ${index + 1} is not an object.`] }
  const raw = input as Record<string, unknown>
  const problems: string[] = []
  const kind = typeof raw.kind === 'string' && KINDS_SET.has(raw.kind) ? (raw.kind as DriverKind) : undefined
  if (!kind) return { problems: [`Entry ${index + 1} has an unsupported kind (${String(raw.kind)}).`] }

  const name = nonEmpty(raw.name, 200) ?? fallbackName(raw)
  const out: ConnectionConfig = { id: nonEmpty(raw.id, 200) ?? '', name, kind }

  const host = nonEmpty(raw.host, 2000)
  if (host) out.host = host
  const port = int(raw.port, 1, 65_535)
  if (port !== undefined) out.port = port
  const user = nonEmpty(raw.user, 2000)
  if (user) out.user = user
  const database = nonEmpty(raw.database, 500)
  if (database) out.database = database
  const uri = nonEmpty(raw.uri, 4000)
  if (uri) out.uri = uri
  const authSource = nonEmpty(raw.authSource, 500)
  if (authSource) out.authSource = authSource
  const socketPath = nonEmpty(raw.socketPath, 4000)
  if (socketPath) out.socketPath = socketPath
  const filePath = nonEmpty(raw.filePath, 4000)
  if (filePath) out.filePath = filePath
  const dataCenter = nonEmpty(raw.dataCenter, 500)
  if (dataCenter) out.dataCenter = dataCenter
  const region = nonEmpty(raw.region, 500)
  if (region) out.region = region
  const group = nonEmpty(raw.group, 200)
  if (group) out.group = group
  const sslCaPath = nonEmpty(raw.sslCaPath, 4000)
  if (sslCaPath) out.sslCaPath = sslCaPath
  const sslClientCertPath = nonEmpty(raw.sslClientCertPath, 4000)
  if (sslClientCertPath) out.sslClientCertPath = sslClientCertPath
  const sslClientKeyPath = nonEmpty(raw.sslClientKeyPath, 4000)
  if (sslClientKeyPath) out.sslClientKeyPath = sslClientKeyPath

  const ssl = flag(raw.ssl); if (ssl !== undefined) out.ssl = ssl
  const sslVerify = flag(raw.sslVerify); if (sslVerify !== undefined) out.sslVerify = sslVerify
  const readonly = flag(raw.readonly); if (readonly !== undefined) out.readonly = readonly
  const confirmWrites = flag(raw.confirmWrites); if (confirmWrites !== undefined) out.confirmWrites = confirmWrites
  if (typeof raw.profile === 'string' && PROFILE_SET.has(raw.profile)) out.profile = raw.profile as ConnectionProfile
  if (typeof raw.color === 'string' && COLOR_SET.has(raw.color)) out.color = raw.color as ConnectionColor

  const session = cleanSession(raw.session); if (session) out.session = session
  const variables = stringMap(raw.variables); if (variables) out.variables = variables
  const ssh = cleanSsh(raw.ssh); if (ssh) out.ssh = ssh
  const proxy = cleanProxy(raw.proxy); if (proxy) out.proxy = proxy
  if (kind === 'jdbc') {
    const jdbc = cleanJdbc(raw.jdbc)
    if (jdbc) out.jdbc = jdbc
    else problems.push(`"${name}" is a JDBC data source without a JDBC URL.`)
  }
  return { connection: out, problems }
}

export interface ParsedConnections {
  connections: ConnectionConfig[]
  /** Entries that were skipped or repaired, ready to show after the import. */
  warnings: string[]
}

/** Parse a file produced by `exportConnections`; a bare array is accepted for hand-written files. */
export function parseConnections(text: string): ParsedConnections {
  const source = text.trim()
  if (!source) throw new Error('The file is empty.')
  let root: unknown
  try { root = JSON.parse(source) }
  catch (e) { throw new Error(`The file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`) }

  let entries: unknown[]
  if (Array.isArray(root)) entries = root
  else if (root && typeof root === 'object' && Array.isArray((root as { connections?: unknown }).connections)) {
    const doc = root as { format?: unknown; version?: unknown; connections: unknown[] }
    if (doc.format !== undefined && doc.format !== CONNECTION_EXPORT_FORMAT) {
      throw new Error(`Unknown connection file format: ${String(doc.format)}`)
    }
    if (typeof doc.version === 'number' && doc.version > CONNECTION_EXPORT_VERSION) {
      throw new Error(`The file uses format version ${doc.version}; this Stratum build supports version ${CONNECTION_EXPORT_VERSION}.`)
    }
    entries = doc.connections
  } else {
    throw new Error('The file does not contain a connection list.')
  }
  if (!entries.length) throw new Error('No connections found in the file.')
  if (entries.length > MAX_IMPORTED) throw new Error(`The file contains ${entries.length} connections; the limit is ${MAX_IMPORTED}.`)

  const connections: ConnectionConfig[] = []
  const warnings: string[] = []
  entries.forEach((entry, index) => {
    const { connection, problems } = sanitizeConnection(entry, index)
    warnings.push(...problems)
    if (connection) connections.push(connection)
  })
  if (!connections.length) throw new Error(`No valid connections found. ${warnings[0] ?? ''}`.trim())
  return { connections, warnings }
}

/** Portable payload: safe fields only, secrets and secret flags removed. */
export function exportConnections(configs: readonly ConnectionConfig[], exportedAt: Date = new Date()): string {
  const connections = configs.map((c) => sanitizeConnection(c).connection).filter((c): c is ConnectionConfig => !!c)
  return `${JSON.stringify({
    format: CONNECTION_EXPORT_FORMAT,
    version: CONNECTION_EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    connections,
  }, null, 2)}\n`
}

/** `report (2)`, `report (3)`… against the names already in the store. */
export function uniqueConnectionName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()))
  const base = name.trim().slice(0, 190) || 'Imported data source'
  if (!used.has(base.toLowerCase())) return base
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base} (${i})`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  return `${base} (${Date.now()})`
}

/** Fresh ids and non-colliding names: an import never overwrites an existing data source. */
export function prepareImport(
  connections: readonly ConnectionConfig[],
  existingNames: readonly string[],
  idFactory: () => string = () => crypto.randomUUID(),
): ConnectionConfig[] {
  const names = [...existingNames]
  return connections.map((c) => {
    const name = uniqueConnectionName(c.name, names)
    names.push(name)
    return { ...c, id: idFactory(), name }
  })
}
