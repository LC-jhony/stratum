/** Builds the read-only URL/DSN preview shown in the data-source dialog. Secrets never appear. */
import type { ConnectionConfig, DriverKind } from '../shared/types'

const URI_PASSWORD = /(\b(?:jdbc:)?[a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)([^@\s]+)(@)/gi
const SECRET_PARAM = /((?:password|passwd|pwd|secret|token|access[_-]?token|api[_-]?key|sslkeypassphrase|sslpassword)\s*=\s*)([^&;\s]+)/gi

/** Replace URL user-info passwords and secret-looking query parameters with a placeholder. */
export function redactSecrets(text: string): string {
  return text
    .replace(URI_PASSWORD, '$1•••$3')
    .replace(SECRET_PARAM, '$1•••')
}

const SCHEME: Partial<Record<DriverKind, string>> = {
  postgres: 'postgresql',
  mysql: 'mysql',
  mongodb: 'mongodb',
  redis: 'redis',
  elastic: 'http',
  cassandra: 'cassandra',
  s3: 's3',
  ftp: 'ftp',
  kafka: 'kafka',
  rabbitmq: 'amqp',
}

const DEFAULT_PORT: Partial<Record<DriverKind, number>> = {
  postgres: 5432,
  mysql: 3306,
  mongodb: 27017,
  redis: 6379,
  elastic: 9200,
  cassandra: 9042,
  s3: 443,
  ftp: 21,
  kafka: 9092,
  rabbitmq: 15672,
}

export interface ConnectionPreview {
  /** URL/DSN with every secret redacted. */
  text: string
  /** Network helper summary (SSH or proxy), without credentials. */
  helper?: string
}

const enc = encodeURIComponent
const user = (value?: string): string => (value?.trim() ? `${enc(value.trim())}@` : '')
const host = (value?: string): string => {
  const h = value?.trim() || 'localhost'
  return h.includes(':') && !h.startsWith('[') ? `[${h}]` : h
}
const database = (value?: string): string => (value?.trim() ? `/${enc(value.trim())}` : '')
const params = (entries: [string, string][]): string => (entries.length ? `?${entries.map(([k, v]) => `${k}=${enc(v)}`).join('&')}` : '')

/** Where a driver keeps its connection string; the dialog shows this under the fields. */
export function connectionPreview(config: ConnectionConfig): ConnectionPreview {
  const helper = networkHelper(config)
  if (config.kind === 'sqlite') {
    const file = config.filePath?.trim()
    return { text: file === ':memory:' ? 'sqlite::memory:' : `sqlite:${file || '(no file selected)'}` }
  }
  if (config.kind === 'jdbc') {
    return { text: redactSecrets(config.jdbc?.url?.trim() || 'jdbc:(not configured)'), helper }
  }
  const uri = config.uri?.trim()
  if (uri && (config.kind === 'mongodb' || config.kind === 'redis')) {
    return { text: redactSecrets(uri), helper }
  }
  const socket = config.socketPath?.trim()
  if (socket && config.kind === 'mysql') {
    return { text: `mysql+unix://${socket}${database(config.database)}`, helper }
  }
  if (socket && config.kind === 'postgres') {
    return { text: `postgresql://${database(config.database)}?host=${enc(socket)}`, helper }
  }

  const scheme = SCHEME[config.kind] ?? config.kind
  const port = config.port ?? DEFAULT_PORT[config.kind]
  const query: [string, string][] = []
  if (config.ssl && scheduleSsl(config.kind)) {
    if (config.kind === 'postgres') query.push(['sslmode', config.sslVerify ? 'verify-full' : 'require'])
    else query.push(['ssl-mode', config.sslVerify ? 'VERIFY_IDENTITY' : 'REQUIRED'])
  }
  if (config.kind === 'mongodb' && config.authSource?.trim()) query.push(['authSource', config.authSource.trim()])
  return {
    text: `${scheme}://${user(config.user)}${host(config.host)}${port ? `:${port}` : ''}${database(config.database)}${params(query)}`,
    helper,
  }
}

/** Only the SQL drivers have a URL spelling for SSL that users recognise. */
const scheduleSsl = (kind: DriverKind): boolean => kind === 'postgres' || kind === 'mysql'

/** Helper summary: never includes passwords, key contents or proxy credentials. */
export function networkHelper(config: ConnectionConfig): string | undefined {
  if (config.ssh?.enabled) {
    const jump = config.ssh.jumpHosts?.length ? ` +${config.ssh.jumpHosts.length} jump` : ''
    return `SSH ${config.ssh.user?.trim() ? `${config.ssh.user.trim()}@` : ''}${config.ssh.host?.trim() || 'jump host'}:${config.ssh.port ?? 22}${jump}`
  }
  if (config.proxy?.enabled) {
    const label = config.proxy.type === 'socks5' ? 'SOCKS5' : 'HTTP'
    const port = config.proxy.port ?? (config.proxy.type === 'socks5' ? 1080 : 3128)
    return `${label} proxy ${config.proxy.host?.trim() || 'proxy'}:${port}`
  }
  return undefined
}
