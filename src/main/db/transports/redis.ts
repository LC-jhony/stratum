import { Redis } from 'ioredis'
import type { ColumnMeta, ConnectionConfig, RawResult, SchemaInfo, TableInfo } from '../../../shared/types'
import type { Transport } from '../types'

/**
 * Redis transport (read-only MVP).
 *
 * The console runs redis-cli-style commands — `GET k`, `HGETALL h`, `SCAN 0 COUNT 100`, `SELECT 2` —
 * guarded by an allowlist of read-only commands plus a few subcommand checks: anything else fails
 * with a clear message in the results pane before it reaches the server. `SCAN` keeps the cursor
 * visible in the grid so paging stays possible; `SELECT` is allowed because it only changes which
 * database this session queries.
 *
 * The explorer model maps databases to schemas (`db0`, `db1`…) and keys to tables. Introspection
 * samples keys with `SCAN` on a second (duplicated) connection so user SELECTs never disturb it,
 * and reports each key's `TYPE` as its column. Opening a "table" runs the INSPECT helper below,
 * which reads the value with type-specific, offset-paged commands.
 *
 * Writes are out of scope by design (like the MongoDB MVP): every mutating command is rejected.
 */

const SCAN_BATCH = 500
const MAX_DBS = 16
const MAX_KEYS_PER_DB = 500
const MAX_KEYS_TOTAL = 2000
const MAX_INSPECT = 2000
const TIME_BUDGET_MS = 8000

/* ------------------------------------------------------------------ command parsing */

export interface RedisCommand { name: string; args: string[] }

/** Tokenizer for redis-cli text: whitespace separated, `"…"` (sdssplitargs escapes) and `'…'` literals. */
export function parseRedisCommand(text: string): RedisCommand | undefined {
  const tokens: string[] = []
  let cur = ''
  let started = false
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        const esc = text[i + 1]
        const hex = esc === 'x' ? /^[0-9A-Fa-f]{2}/.exec(text.slice(i + 2)) : null
        if (hex) { cur += String.fromCharCode(parseInt(hex[0], 16)); i += hex[0].length + 1; continue }
        cur += ESCAPES[esc] ?? esc
        i++
        continue
      }
      if (ch === quote) { quote = undefined; continue }
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue }
    if (/\s/.test(ch)) { if (started || cur) { tokens.push(cur); cur = ''; started = false } continue }
    cur += ch
  }
  if (started || cur) tokens.push(cur)
  if (!tokens.length) return undefined
  return { name: tokens[0].toUpperCase(), args: tokens.slice(1) }
}

/** Double-quoted escapes, matching redis-cli's sdssplitargs. */
const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', a: '\a' }

/** Commands that only read connection/server state; `INSPECT` is Stratum's paged value reader. */
const READ_COMMANDS = new Set([
  'PING', 'ECHO', 'TIME', 'DBSIZE', 'LASTSAVE', 'INFO', 'SELECT', 'COMMAND', 'DUMP', 'RANDOMKEY', 'INSPECT',
  'TYPE', 'TTL', 'PTTL', 'EXISTS', 'KEYS', 'SCAN', 'SSCAN', 'HSCAN', 'ZSCAN',
  'GET', 'MGET', 'GETRANGE', 'SUBSTR', 'STRLEN', 'GETBIT', 'BITCOUNT', 'BITPOS', 'BITFIELD_RO',
  'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'HRANDFIELD',
  'LRANGE', 'LLEN', 'LINDEX', 'LPOS',
  'SMEMBERS', 'SISMEMBER', 'SMISMEMBER', 'SCARD', 'SRANDMEMBER', 'SINTER', 'SINTERCARD', 'SUNION', 'SDIFF',
  'ZRANGE', 'ZRANGEBYSCORE', 'ZREVRANGE', 'ZREVRANGEBYSCORE', 'ZRANGEBYLEX', 'ZREVRANGEBYLEX',
  'ZSCORE', 'ZMSCORE', 'ZCARD', 'ZCOUNT', 'ZRANK', 'ZREVRANK', 'ZLEXCOUNT', 'ZDIFF', 'ZINTER', 'ZINTERCARD', 'ZUNION', 'ZRANDMEMBER',
  'XLEN', 'XRANGE', 'XREVRANGE',
  'PFCOUNT', 'GEOPOS', 'GEODIST', 'GEOHASH', 'GEOSEARCH',
])

/** Commands whose first argument must be one of the listed read-only subcommands. */
const SUBCOMMANDS: Record<string, Set<string>> = {
  CLIENT: new Set(['LIST', 'INFO', 'GETNAME', 'ID']),
  MEMORY: new Set(['USAGE', 'DOCTOR']),
  OBJECT: new Set(['ENCODING', 'REFCOUNT', 'IDLETIME', 'FREQ']),
  LATENCY: new Set(['LATEST', 'HISTORY']),
  XINFO: new Set(['STREAM', 'GROUPS', 'CONSUMERS', 'FULL']),
}
/** RedisJSON read commands, the only module command family with a strict read subset. */
const JSON_READ = new Set(['GET', 'MGET', 'TYPE', 'STRLEN', 'ARRINDEX', 'ARRLEN', 'OBJLEN', 'OBJKEYS', 'RESP'])

/** True when the statement is on the read-only allowlist — used by the console and by "read-only" sources. */
export function isRedisRead(stmt: string): boolean {
  const cmd = parseRedisCommand(stmt)
  if (!cmd) return false
  if (cmd.name.startsWith('JSON.')) return JSON_READ.has(cmd.name.slice(5))
  const sub = SUBCOMMANDS[cmd.name]
  if (sub) return !!cmd.args[0] && sub.has(cmd.args[0].toUpperCase())
  return READ_COMMANDS.has(cmd.name)
}

/** Reads the value grid fetches (`INSPECT <key>`) get their page size attached here. */
export function paginateRedisStatement(sql: string, limit: number, offset: number): string | undefined {
  const cmd = parseRedisCommand(sql)
  if (cmd?.name !== 'INSPECT' || !cmd.args[0]) return undefined
  return `INSPECT ${JSON.stringify(cmd.args[0])} ${offset} ${limit}`
}

/* ------------------------------------------------------------------ replies to grid rows */

const valueCol = (name = 'value'): ColumnMeta[] => [{ name }]

const scalar = (v: unknown): RawResult => ({ columns: valueCol(), rows: [[v]] })

const rowsOf = (label: string, items: unknown[]): RawResult => ({ columns: valueCol(label), rows: items.map((v) => [v]) })

/** Flat `[field, value, field, value…]` arrays (HGETALL-style maps) into two columns. */
const pairsOf = (flat: unknown[]): RawResult => ({
  columns: [{ name: 'field' }, { name: 'value' }],
  rows: Array.from({ length: Math.floor(flat.length / 2) }, (_, i) => [flat[i * 2], flat[i * 2 + 1]]),
})

/** One stream entry `[id, [field, value, …]]` → `[id, {field: value}]` (the grid stringifies objects). */
const streamRow = (entry: unknown): [unknown, unknown] => {
  const [id, fields] = Array.isArray(entry) ? entry : [entry, []]
  const flat = Array.isArray(fields) ? fields : []
  return [id, Object.fromEntries(Array.from({ length: Math.floor(flat.length / 2) }, (_, i) => [flat[i * 2], flat[i * 2 + 1]]))]
}

const WITH_SCORES = /^Z(?:REV)?RANGE(?:BYSCORE|BYLEX)?$/

/** Redis replies (ioredis with RESP3) as grid results. Shapes verified against Redis 8. */
export function replyToResult(cmd: RedisCommand, reply: unknown): RawResult {
  if (reply === null || reply === undefined) return scalar(null)
  if (!Array.isArray(reply)) return scalar(reply)
  if (cmd.name === 'HGETALL') return pairsOf(reply)
  if (cmd.name === 'SCAN' || cmd.name === 'SSCAN' || cmd.name === 'ZSCAN') {
    const [cursor, items] = reply as [unknown, unknown[]]
    const label = cmd.name === 'SCAN' ? 'key' : 'member'
    const cols = [{ name: 'cursor' }, { name: label }]
    const rows = (items ?? []).map((k) => [cursor, k])
    return { columns: cols, rows: rows.length ? rows : [[cursor, null]] }
  }
  if (cmd.name === 'HSCAN') {
    const [cursor, flat] = reply as [unknown, unknown[]]
    const rows = Array.from({ length: Math.floor((flat?.length ?? 0) / 2) }, (_, i) => [cursor, flat[i * 2], flat[i * 2 + 1]])
    return { columns: [{ name: 'cursor' }, { name: 'field' }, { name: 'value' }], rows: rows.length ? rows : [[cursor, null, null]] }
  }
  if (cmd.name === 'XRANGE' || cmd.name === 'XREVRANGE') {
    return { columns: [{ name: 'id' }, { name: 'fields' }], rows: reply.map(streamRow) }
  }
  if (WITH_SCORES.test(cmd.name) && cmd.args.some((a) => a.toUpperCase() === 'WITHSCORES')) {
    const pairs = reply.map((e) => (Array.isArray(e) ? e : [e]))
    return { columns: [{ name: 'member' }, { name: 'score' }], rows: pairs }
  }
  if (cmd.name === 'XINFO') return pairsOf(reply)
  if (/^(SMEMBERS|SINTER|SUNION|SDIFF|SRANDMEMBER|SINTERCARD)$/.test(cmd.name)) return rowsOf('member', reply)
  if (/^(KEYS|SCAN)$/.test(cmd.name)) return rowsOf('key', reply)
  if (cmd.name === 'HKEYS') return rowsOf('field', reply)
  return rowsOf('value', reply)
}

/* ------------------------------------------------------------------ transport */

export class RedisTransport implements Transport {
  private client: Redis
  private scanner?: Redis
  private db: number

  constructor(private cfg: ConnectionConfig) {
    this.db = Number.parseInt(cfg.database ?? '', 10)
    if (!Number.isFinite(this.db) || this.db < 0) this.db = 0
    const uri = cfg.uri?.trim()
    if (uri) this.client = new Redis(uri, this.timeouts())
    else if (cfg.socketPath?.trim()) this.client = new Redis({ ...this.timeouts(), path: cfg.socketPath.trim() })
    else this.client = new Redis({
      ...this.timeouts(),
      host: cfg.host?.trim() || '127.0.0.1',
      port: cfg.port && cfg.port > 0 ? cfg.port : 6379,
      username: cfg.user || undefined,
      password: cfg.password || undefined,
      db: this.db,
    })
  }

  /**
   * No reconnect-by-retry: a dropped session must surface an error (and let the user reconnect)
   * instead of queueing commands forever; `maxRetriesPerRequest: 1` keeps failures fast.
   * Endpoint fields stay out of this object so a connection string (or the SSH tunnel's rewritten
   * one) keeps its own host, port, credentials and database index.
   */
  private timeouts() {
    return {
      ...(this.cfg.ssl ? { tls: {} } : {}),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      connectTimeout: 10_000,
    }
  }

  async open(): Promise<{ version?: string }> {
    try {
      await this.client.connect()
    } catch (e) {
      throw new Error(`Redis connection failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    let version: string | undefined
    try {
      version = /redis_version:([^\r\n]+)/.exec(String(await this.client.call('INFO', 'server')))?.[1]
    } catch { /* INFO may be renamed/disabled: the session still works without a version */ }
    return { version }
  }

  async query(sql: string): Promise<RawResult> {
    const text = sql.trim()
    const cmd = parseRedisCommand(text)
    if (!cmd) throw new Error('Empty Redis command.')
    if (cmd.name === 'INSPECT') return this.inspect(cmd.args)
    if (!isRedisRead(text)) throw new Error(`Command "${cmd.name}" is not allowed: this Redis console is read-only.`)
    try {
      return replyToResult(cmd, await this.client.call(cmd.name, ...cmd.args))
    } catch (e) {
      throw new Error(`Redis error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Redis has no per-command cancellation; the promise settles when the server replies. */
  async cancel(): Promise<void> { /* no-op */ }

  async close(): Promise<void> {
    const scanner = this.scanner
    this.scanner = undefined
    if (scanner) await scanner.quit().catch(() => { scanner.disconnect() })
    await this.client.quit().catch(() => { this.client.disconnect() })
  }

  /* -------------------------------------------------- key value reader (INSPECT) */

  /** `INSPECT <key> [offset count]` — the TableEditor's paged, type-aware reader. */
  private async inspect(args: string[]): Promise<RawResult> {
    const [key, offsetArg, countArg] = args
    if (!key) throw new Error('INSPECT needs a key.')
    const offset = Math.max(0, Number.parseInt(offsetArg ?? '0', 10) || 0)
    const count = Math.min(MAX_INSPECT, Math.max(1, Number.parseInt(countArg ?? '500', 10) || 500))
    const type = String(await this.client.call('TYPE', key))
    if (type === 'none') throw new Error(`Key "${key}" does not exist (it may have expired).`)
    const page = async (rows: unknown[][]): Promise<RawResult> => ({ columns: this.columnsFor(type), rows: rows.slice(offset, offset + count) })
    if (type === 'string') return { columns: valueCol(), rows: offset > 0 ? [] : [[await this.client.call('GET', key)]] }
    if (type === 'hash') {
      const flat = (await this.client.call('HGETALL', key)) as unknown[]
      const rows = Array.from({ length: Math.floor(flat.length / 2) }, (_, i) => [flat[i * 2], flat[i * 2 + 1]])
      return page(rows)
    }
    if (type === 'list') {
      const items = (await this.client.call('LRANGE', key, offset, offset + count - 1)) as unknown[]
      return { columns: [{ name: 'index' }, { name: 'value' }], rows: items.map((v, i) => [offset + i, v]) }
    }
    if (type === 'set') {
      const members = await this.scanMembers(key, offset + count)
      return page(members.map((m) => [m]))
    }
    if (type === 'zset') {
      const pairs = (await this.client.call('ZRANGE', key, offset, offset + count - 1, 'WITHSCORES')) as unknown[]
      return { columns: [{ name: 'member' }, { name: 'score' }], rows: pairs.map((e) => (Array.isArray(e) ? e : [e])) }
    }
    if (type === 'stream') {
      const entries = (await this.client.call('XRANGE', key, '-', '+', 'COUNT', offset + count)) as unknown[]
      return { columns: [{ name: 'id' }, { name: 'fields' }], rows: entries.slice(offset).map(streamRow) }
    }
    // Modules (JSON, timeseries, …) and future types: read the whole value, mapped generically.
    const dump = await this.client.call('DUMP', key)
    return { columns: valueCol(), rows: offset > 0 ? [] : [[dump]] }
  }

  private columnsFor(type: string): ColumnMeta[] {
    if (type === 'hash') return [{ name: 'field' }, { name: 'value' }]
    if (type === 'set') return [{ name: 'member' }]
    return valueCol()
  }

  /** Walks SSCAN cursors until `want` members are collected (bounded: SCAN order is arbitrary anyway). */
  private async scanMembers(key: string, want: number): Promise<string[]> {
    const out: string[] = []
    let cursor = '0'
    do {
      const [next, batch] = (await this.client.call('SSCAN', key, cursor, 'COUNT', SCAN_BATCH)) as [string, string[]]
      cursor = next
      out.push(...(batch ?? []))
    } while (cursor !== '0' && out.length < Math.min(want, MAX_INSPECT))
    return out
  }

  /* -------------------------------------------------- explorer model */

  /** Databases → schemas, sampled keys → tables, `TYPE` → the key's column. */
  async introspectModel(): Promise<{ schemas: SchemaInfo[] }> {
    const deadline = Date.now() + TIME_BUDGET_MS
    const spaces = await this.keyspace()
    const dbs = (spaces.length ? spaces : [{ db: this.db, keys: 0 }]).slice(0, MAX_DBS)
    const schemas: SchemaInfo[] = []
    let budget = MAX_KEYS_TOTAL
    for (const { db } of dbs) {
      if (Date.now() > deadline || budget <= 0) break
      const keys = await this.scanKeys(db, Math.min(MAX_KEYS_PER_DB, budget), deadline)
      budget -= keys.length
      const types = await this.keyTypes(db, keys)
      schemas.push({ name: `db${db}`, tables: keys.sort().map((k) => tableOf(k, types.get(k) ?? 'unknown')) })
    }
    return { schemas }
  }

  /** Non-empty databases reported by INFO keyspace (a fresh server reports none). */
  private async keyspace(): Promise<{ db: number; keys: number }[]> {
    try {
      const info = String(await this.client.call('INFO', 'keyspace'))
      return [...info.matchAll(/^db(\d+):keys=(\d+)/gm)].map((m) => ({ db: Number(m[1]), keys: Number(m[2]) }))
    } catch { return [] }
  }

  /** Second connection: SELECTs freely so the user's console database is never disturbed. */
  private scannerClient(): Redis {
    if (!this.scanner) this.scanner = this.client.duplicate({ lazyConnect: true })
    return this.scanner
  }

  private async scanKeys(db: number, limit: number, deadline: number): Promise<string[]> {
    if (limit <= 0) return []
    const scanner = this.scannerClient()
    if (scanner.status === 'wait') await scanner.connect()
    await scanner.select(db)
    const keys: string[] = []
    let cursor = '0'
    do {
      const [next, batch] = (await scanner.scan(cursor, 'COUNT', SCAN_BATCH)) as [string, string[]]
      cursor = next
      keys.push(...(batch ?? []))
    } while (cursor !== '0' && keys.length < limit && Date.now() < deadline)
    return keys.slice(0, limit)
  }

  private async keyTypes(db: number, keys: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    if (!keys.length) return out
    const scanner = this.scannerClient()
    await scanner.select(db)
    for (let i = 0; i < keys.length; i += SCAN_BATCH) {
      const chunk = keys.slice(i, i + SCAN_BATCH)
      const pipeline = scanner.pipeline()
      for (const key of chunk) pipeline.type(key)
      const replies = await pipeline.exec()
      chunk.forEach((key, j) => {
        const reply = replies?.[j]
        if (reply && !reply[0]) out.set(key, String(reply[1]))
      })
    }
    return out
  }
}

const tableOf = (key: string, type: string): TableInfo => ({
  name: key,
  kind: 'table',
  columns: [{ name: 'type', dataType: type, nullable: true, isPrimaryKey: false, ordinal: 0 }],
  foreignKeys: [],
  indexes: [],
})
