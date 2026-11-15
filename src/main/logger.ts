import { mkdirSync, appendFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Small main-process logger. Electron (and plain Node) tests can use it without the app: every
 * module imports the shared `logger` proxy, and `configureLogger` attaches the rotating file sink
 * once the userData path is known.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LoggerOptions {
  /** Absolute log file; omitted keeps console-only logging. */
  file?: string
  /** Rotate once the file would exceed this size. Default 2 MiB. */
  maxBytes?: number
  /** Rotated files kept as `stratum.log.1` … `.N`. Default 3. */
  backups?: number
  /** Write to the devtools/stdout console too. Default true. */
  console?: boolean
  /** Clock override for deterministic tests. */
  now?: () => Date
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  /** Prefix every line with a subsystem name (`ssh`, `store`, `updates`…). */
  child(scope: string): Logger
}

const SECRET_KEY = /(pass(word|phrase)?|secret|token|api[-_]?key|authorization|private[-_]?key|cookie|credential)/i
const MAX_DEPTH = 6
const MAX_ARRAY = 100

/**
 * Recursively mask values whose key looks like a credential. The logger never assumes a payload is
 * safe: connection configs, updater responses and SSH errors all pass through here.
 */
export function redact(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[depth-limit]'
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => redact(v, seen, depth + 1))
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), ...(value.stack ? { stack: redactText(value.stack) } : {}) }
  }
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(v, seen, depth + 1)
  }
  return out
}

/** Mask credentials embedded in free text (connection URLs, `password=…` fragments). */
export function redactText(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@]+)@/gi, '$1[redacted]@')
    .replace(/\b(password|passwd|pwd|passphrase|token|secret|api[_-]?key|authorization)\b(\s*[=:]\s*)([^\s,;&]+)/gi, '$1$2[redacted]')
}

function describe(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  try { return JSON.stringify(redact(value)) } catch { return String(value) }
}

function formatLine(level: LogLevel, scope: string, message: string, args: unknown[], date: Date): string {
  const rest = args.map(describe).join(' ')
  const prefix = scope ? `[${scope}] ` : ''
  return redactText(`${date.toISOString()} [${level.toUpperCase()}] ${prefix}${message}${rest ? ' ' + rest : ''}`)
}

function rotate(file: string, backups: number) {
  if (backups <= 0) { rmSync(file, { force: true }); return }
  rmSync(`${file}.${backups}`, { force: true })
  for (let i = backups - 1; i >= 1; i--) {
    if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`)
  }
  if (existsSync(file)) renameSync(file, `${file}.1`)
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const { file, maxBytes = 2 * 1024 * 1024, backups = 3, console: toConsole = true, now = () => new Date() } = options
  let dirReady = false

  const write = (level: LogLevel, scope: string, message: string, args: unknown[]) => {
    const line = formatLine(level, scope, message, args, now())
    if (toConsole) {
      const sink = level === 'debug' ? console.debug : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error
      sink(line)
    }
    if (!file) return
    try {
      if (!dirReady) { mkdirSync(path.dirname(file), { recursive: true }); dirReady = true }
      if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) + 1 > maxBytes) rotate(file, backups)
      appendFileSync(file, line + '\n')
    } catch (e) {
      // Logging must never break the application. A once-off console note is enough.
      if (toConsole) console.error('[logger] could not write the log file:', e)
    }
  }

  const make = (scope: string): Logger => ({
    debug: (message, ...args) => write('debug', scope.trim(), message, args),
    info: (message, ...args) => write('info', scope.trim(), message, args),
    warn: (message, ...args) => write('warn', scope.trim(), message, args),
    error: (message, ...args) => write('error', scope.trim(), message, args),
    child: (name) => make([scope, name].filter(Boolean).join(':')),
  })

  return make('')
}

/** Shared logger used by every main-process module; console until `configureLogger` attaches a file. */
let active = createLogger()

export const logger: Logger = {
  debug: (message, ...args) => active.debug(message, ...args),
  info: (message, ...args) => active.info(message, ...args),
  warn: (message, ...args) => active.warn(message, ...args),
  error: (message, ...args) => active.error(message, ...args),
  child: (scope) => active.child(scope),
}

export function configureLogger(options: LoggerOptions): Logger {
  active = createLogger(options)
  return active
}
