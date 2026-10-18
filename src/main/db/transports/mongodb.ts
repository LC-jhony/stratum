import { Binary, Decimal128, Int32, Long, MongoClient, ObjectId, Timestamp, Double, type Document, type Sort } from 'mongodb'
import type { ConnectionConfig, RawResult } from '../../../shared/types'
import type { Transport } from '../types'

/**
 * MongoDB transport. Console statements are mongosh-style expressions parsed by a small
 * hand-written reader (never `eval`), restricted to read-only operations:
 *
 *   db.users.find({age:{$gt:30}}).sort({age:1}).project({name:1}).skip(20).limit(50)
 *   db.getSiblingDB("sales").getCollection("logs-2024").find({})
 *   db.orders.aggregate([{$group:{_id:"$status", n:{$sum:1}}}])
 *   db.users.countDocuments({active:true}) | db.users.distinct("country") | db.users.estimatedDocumentCount()
 *   db.runCommand({...}) | db.adminCommand({...})          // introspection and read commands
 *
 * Argument documents accept JavaScript-ish literals (unquoted keys), single/double-quoted strings and
 * the common BSON constructors ObjectId/ISODate/NumberLong/NumberInt/NumberDecimal/Timestamp/UUID.
 * Anything else — updates, drop, eval, JS — fails with an explanatory error before touching the server.
 */

export type BsonDoc = Record<string, unknown>

export type MongoStatement =
  | { op: 'find'; db: string; coll: string; filter: BsonDoc; projection?: BsonDoc; sort?: BsonDoc; skip?: number; limit?: number }
  | { op: 'aggregate'; db: string; coll: string; pipeline: unknown[] }
  | { op: 'count'; db: string; coll: string; filter: BsonDoc }
  | { op: 'estimatedCount'; db: string; coll: string }
  | { op: 'distinct'; db: string; coll: string; field: string; filter: BsonDoc }
  | { op: 'command'; admin: boolean; db: string; command: BsonDoc }

const READ_OPS = new Set<MongoStatement['op']>(['find', 'aggregate', 'count', 'estimatedCount', 'distinct'])

/* ------------------------------------------------------------------ reader */

class Reader {
  i = 0
  constructor(readonly s: string) {}

  private err(msg: string): never { throw new Error(`Cannot parse MongoDB statement: ${msg}${this.i < this.s.length ? ` near "${this.s.slice(this.i, this.i + 24)}"` : ' at end of statement'}.`) }
  ws() {
    for (;;) {
      const c = this.s[this.i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { this.i++; continue }
      if (c === '/' && this.s[this.i + 1] === '/') { const e = this.s.indexOf('\n', this.i); this.i = e < 0 ? this.s.length : e; continue }
      if (c === '/' && this.s[this.i + 1] === '*') { const e = this.s.indexOf('*/', this.i + 2); this.i = e < 0 ? this.s.length : e + 2; continue }
      return
    }
  }
  eof() { this.ws(); return this.i >= this.s.length }
  peek(): string | undefined { this.ws(); return this.s[this.i] }
  eat(ch: string): boolean { this.ws(); if (this.s[this.i] === ch) { this.i++; return true } return false }
  expect(ch: string) { if (!this.eat(ch)) this.err(`expected "${ch}"`) }
  ident(): string {
    this.ws()
    const m = /^[$A-Za-z_][\w$]*/.exec(this.s.slice(this.i))
    if (!m) this.err('expected a name')
    this.i += m[0].length
    return m[0]
  }
  string(): string {
    this.ws()
    const q = this.s[this.i]
    if (q !== '"' && q !== "'") this.err('expected a quoted string')
    let out = ''
    for (let j = this.i + 1; j < this.s.length; j++) {
      const c = this.s[j]
      if (c === '\\') {
        const e = this.s[j + 1]
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e
        j++
        continue
      }
      if (c === q) { this.i = j + 1; return out }
      out += c
    }
    return this.err('unterminated string')
  }
  number(): number {
    this.ws()
    const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.s.slice(this.i))
    if (!m) this.err('expected a number')
    this.i += m[0].length
    return Number(m[0])
  }

  /** JavaScript-ish value: `true`, `null`, numbers, strings, arrays, objects and BSON constructors. */
  value(): unknown {
    const c = this.peek()
    if (c === undefined) return this.err('expected a value')
    if (c === '{') return this.object()
    if (c === '[') return this.array()
    if (c === '"' || c === "'") return this.string()
    if (c === '-' || (c >= '0' && c <= '9')) return this.number()
    const word = /^[A-Za-z_]\w*/.exec(this.s.slice(this.i))?.[0]
    if (!word) return this.err('expected a value')
    const after = this.i + word.length
    this.i = after
    if (/^\s*\(/.test(this.s.slice(after)) && word !== 'true' && word !== 'false' && word !== 'null') return this.constructorCall(word)
    if (word === 'true') return true
    if (word === 'false') return false
    if (word === 'null') return null
    return this.err(`unknown value "${word}"`)
  }
  private constructorCall(name: string): unknown {
    this.expect('(')
    const fn = CONSTRUCTORS[name]
    if (!fn) this.err(`unsupported constructor "${name}"`)
    const args: unknown[] = []
    if (!this.eat(')')) {
      for (;;) {
        args.push(this.value())
        if (this.eat(')')) break
        this.expect(',')
      }
    }
    try { return (fn as (...a: unknown[]) => unknown)(...args) } catch (e) { this.err(`${name}(): ${e instanceof Error ? e.message : String(e)}`) }
  }
  private object(): BsonDoc {
    this.expect('{')
    const out: BsonDoc = {}
    if (this.eat('}')) return out
    for (;;) {
      this.ws()
      const c = this.s[this.i]
      const key = c === '"' || c === "'" ? this.string() : this.ident()
      this.expect(':')
      out[key] = this.value()
      if (this.eat('}')) return out
      this.expect(',')
    }
  }
  private array(): unknown[] {
    this.expect('[')
    const out: unknown[] = []
    if (this.eat(']')) return out
    for (;;) {
      out.push(this.value())
      if (this.eat(']')) return out
      this.expect(',')
    }
  }
  /** Comma-separated value list inside the parentheses of a method call. */
  args(): unknown[] {
    this.expect('(')
    const out: unknown[] = []
    if (this.eat(')')) return out
    for (;;) {
      out.push(this.value())
      if (this.eat(')')) return out
      this.expect(',')
    }
  }
  asDoc(v: unknown, where: string): BsonDoc {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) this.err(`${where} expects a document`)
    return v as BsonDoc
  }
  asArray(v: unknown, where: string): unknown[] {
    if (!Array.isArray(v)) this.err(`${where} expects an array`)
    return v
  }
}

const CONSTRUCTORS: Record<string, (...a: never[]) => unknown> = {
  ObjectId: ((hex?: string) => (hex === undefined ? new ObjectId() : new ObjectId(hex))) as never,
  ISODate: ((iso: string) => new Date(iso)) as never,
  Date: ((iso: string) => new Date(iso)) as never,
  NumberLong: ((n: string | number) => Long.fromString(String(n))) as never,
  NumberInt: ((n: number) => new Int32(n)) as never,
  NumberDecimal: ((n: string) => Decimal128.fromString(n)) as never,
  Timestamp: ((t: number, i = 0) => new Timestamp({ t, i })) as never,
  UUID: ((hex: string) => new Binary(Buffer.from(hex.replace(/-/g, ''), 'hex'), 4)) as never,
}

/* ------------------------------------------------------------------ statement parser */

/** Parse one mongosh-style statement. Throws with a user-facing message when unsupported. */
export function parseMongoStatement(text: string): MongoStatement {
  const r = new Reader(text)
  r.ws()
  if (r.eof()) throw new Error('Empty MongoDB statement.')
  if (r.ident() !== 'db') throw new Error('Unsupported MongoDB statement: only expressions starting with "db." run in this console.')

  /** `.name`, `["name"]` or `.getCollection("name")` after `db` (or after getSiblingDB(...)). */
  const member = (): string => {
    r.ws()
    if (r.eat('[')) { const name = r.string(); r.expect(']'); return name }
    r.expect('.')
    const name = r.ident()
    if (name === 'getCollection') {
      const [coll] = r.args()
      if (typeof coll !== 'string' || !coll) throw new Error('Cannot parse MongoDB statement: getCollection() expects a collection name string.')
      return coll
    }
    return name
  }
  const end = <T extends MongoStatement>(stmt: T): T => {
    r.ws()
    if (r.eat(';')) r.ws()
    if (!r.eof()) r.expect(';')
    return stmt
  }

  // db.runCommand({...}) / db.adminCommand({...})
  const m0 = member()
  if (m0 === 'runCommand' || m0 === 'adminCommand') {
    const [doc] = r.args()
    return end({ op: 'command', admin: m0 === 'adminCommand', db: m0 === 'adminCommand' ? 'admin' : '', command: r.asDoc(doc, m0) })
  }

  // Optional getSiblingDB("<db>") before the collection — or before runCommand for cross-database commands.
  let db = ''
  let coll = m0
  if (m0 === 'getSiblingDB') {
    const [name] = r.args()
    if (typeof name !== 'string' || !name) throw new Error('Cannot parse MongoDB statement: getSiblingDB() expects a database name string.')
    db = name
    const m1 = member()
    if (m1 === 'runCommand' || m1 === 'adminCommand') {
      const [doc] = r.args()
      return end({ op: 'command', admin: m1 === 'adminCommand', db, command: r.asDoc(doc, m1) })
    }
    coll = m1
  }
  // `db.<name>(...)` with no collection: a database-level operation (dropDatabase, stats, …).
  if (r.peek() === '(') throw new Error(`Unsupported MongoDB operation "${coll}()" — this build runs read-only find, aggregate, countDocuments, estimatedDocumentCount and distinct.`)
  r.expect('.')
  const method = r.ident()
  const args = r.args()

  const chain = (stmt: Extract<MongoStatement, { op: 'find' }>) => {
    while (r.eat('.')) {
      const fn = r.ident()
      const a = r.args()
      if (fn === 'sort') stmt.sort = r.asDoc(a[0], 'sort()')
      else if (fn === 'project' || fn === 'projection') stmt.projection = r.asDoc(a[0], `${fn}()`)
      else if (fn === 'skip') stmt.skip = int(a[0], 'skip()')
      else if (fn === 'limit') stmt.limit = int(a[0], 'limit()')
      else if (fn === 'pretty') { /* display hint in the shell; nothing to do */ }
      else throw new Error(`Unsupported MongoDB cursor method ".${fn}()" — this build runs read-only find/aggregate/count/distinct.`)
    }
    return stmt
  }

  switch (method) {
    case 'find':
      return end(chain({ op: 'find', db, coll, filter: r.asDoc(args[0] ?? {}, 'find()'), projection: args[1] === undefined ? undefined : r.asDoc(args[1], 'find()') }))
    case 'findOne': {
      const stmt = chain({ op: 'find', db, coll, filter: r.asDoc(args[0] ?? {}, 'findOne()'), projection: args[1] === undefined ? undefined : r.asDoc(args[1], 'findOne()') })
      stmt.limit ??= 1
      return end(stmt)
    }
    case 'aggregate':
      while (r.eat('.')) {
        const fn = r.ident()
        r.args()
        if (fn !== 'pretty') throw new Error(`Unsupported MongoDB cursor method ".${fn}()" on aggregate — use a pipeline stage such as $limit.`)
      }
      return end({ op: 'aggregate', db, coll, pipeline: r.asArray(args[0], 'aggregate()') })
    case 'count':
    case 'countDocuments':
      return end({ op: 'count', db, coll, filter: r.asDoc(args[0] ?? {}, `${method}()`) })
    case 'estimatedDocumentCount':
      return end({ op: 'estimatedCount', db, coll })
    case 'distinct': {
      const field = args[0]
      if (typeof field !== 'string') throw new Error('Cannot parse MongoDB statement: distinct() expects a field name string.')
      return end({ op: 'distinct', db, coll, field, filter: r.asDoc(args[1] ?? {}, 'distinct()') })
    }
    default:
      throw new Error(`Unsupported MongoDB operation "${method}()" — this build runs read-only find, aggregate, countDocuments, estimatedDocumentCount and distinct.`)
  }
}

const int = (v: unknown, where: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`Cannot parse MongoDB statement: ${where} expects a non-negative integer.`)
  return v
}

/** True when the statement only reads; the session uses this for read-only sources and paging. */
export function isMongoRead(stmt: string): boolean {
  try { return READ_OPS.has(parseMongoStatement(stmt).op) } catch { return false }
}

/** Add DataGrip-style paging to a find: `.skip(offset).limit(limit)`, unless the user wrote their own. */
export function paginateMongoStatement(stmt: string, limit: number, offset: number): string | undefined {
  let parsed: MongoStatement
  try { parsed = parseMongoStatement(stmt) } catch { return undefined }
  if (parsed.op !== 'find' || parsed.limit !== undefined || parsed.skip !== undefined) return undefined
  const base = stmt.trim().replace(/;\s*$/, '')
  return `${base}.skip(${offset}).limit(${limit})`
}

/* ------------------------------------------------------------------ BSON printing */

/** Turn BSON/driver values into IPC-safe leaves; nested documents keep their shape for the JSON cell. */
export function bsonPrint(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (v instanceof ObjectId) return v.toHexString()
  if (v instanceof Long) return v.toString()
  if (v instanceof Decimal128) return v.toString()
  if (v instanceof Int32 || v instanceof Double) return Number(v.valueOf())
  if (v instanceof Timestamp) return { $timestamp: { t: v.t, i: v.i } }
  if (v instanceof Binary) return v.buffer
  if (Array.isArray(v)) return v.map(bsonPrint)
  if (v instanceof Date || typeof v !== 'object') return v
  const tag = (v as { _bsontype?: string })._bsontype
  switch (tag) {
    case 'Code': return (v as { code?: string }).code ?? ''
    case 'BSONRegExp': return (v as { pattern?: string }).pattern ?? ''
    case 'MinKey': return '$minKey'
    case 'MaxKey': return '$maxKey'
    case 'ObjectId': return Buffer.from((v as { id?: Uint8Array }).id ?? []).toString('hex')
    case 'Long': case 'Decimal128': return String(v)
    case 'Int32': case 'Double': return Number(String(v))
    case 'Binary': return (v as { buffer?: Uint8Array }).buffer ?? null
    case 'Timestamp': { const ts = v as { t?: number; i?: number }; return { $timestamp: { t: ts.t, i: ts.i } } }
  }
  return Object.fromEntries(Object.entries(v as BsonDoc).map(([k, x]) => [k, bsonPrint(x)]))
}

/** Documents → columns/rows: ordered union of top-level keys, `_id` first. */
export function docsToResult(docs: BsonDoc[]): RawResult {
  const cols: string[] = []
  const seen = new Set<string>()
  for (const d of docs) for (const k of Object.keys(d)) if (!seen.has(k)) { seen.add(k); cols.push(k) }
  const id = cols.indexOf('_id')
  if (id > 0) { cols.splice(id, 1); cols.unshift('_id') }
  return {
    columns: cols.map((name) => ({ name })),
    rows: docs.map((d) => cols.map((k) => (k in d ? bsonPrint(d[k]) : null))),
  }
}

/* ------------------------------------------------------------------ transport */

export class MongoTransport implements Transport {
  private client?: MongoClient
  constructor(private cfg: ConnectionConfig) {}

  private uri(): string {
    const c = this.cfg
    if (c.uri?.trim()) return c.uri.trim()
    const auth = c.user ? `${encodeURIComponent(c.user)}${c.password ? `:${encodeURIComponent(c.password)}` : ''}@` : ''
    const host = c.host || 'localhost'
    const db = c.database ? `/${encodeURIComponent(c.database)}` : '/'
    const q = c.authSource ? `?authSource=${encodeURIComponent(c.authSource)}` : ''
    return `mongodb://${auth}${host}:${c.port ?? 27017}${db}${q}`
  }

  async open() {
    const client = new MongoClient(this.uri(), { serverSelectionTimeoutMS: 10_000, appName: 'Stratum' })
    await client.connect()
    this.client = client
    const info = await client.db('admin').command({ buildInfo: 1 })
    return { version: String(info.version ?? '') }
  }

  private db(stmt: { db: string }) { return this.client!.db(stmt.db || this.cfg.database || 'test') }

  async query(stmt: string): Promise<RawResult> {
    if (!this.client) throw new Error('MongoDB data source is not connected.')
    const p = parseMongoStatement(stmt)
    switch (p.op) {
      case 'find': {
        const coll = this.db(p).collection(p.coll)
        let cursor = coll.find(p.filter, p.projection ? { projection: p.projection } : undefined)
        if (p.sort) cursor = cursor.sort(p.sort as Sort)
        if (p.skip) cursor = cursor.skip(p.skip)
        if (p.limit !== undefined) cursor = cursor.limit(p.limit)
        return docsToResult(await cursor.toArray())
      }
      case 'aggregate':
        return docsToResult(await this.db(p).collection(p.coll).aggregate(p.pipeline as Document[]).toArray())
      case 'count':
        return { columns: [{ name: 'count' }], rows: [[await this.db(p).collection(p.coll).countDocuments(p.filter)]] }
      case 'estimatedCount':
        return { columns: [{ name: 'count' }], rows: [[await this.db(p).collection(p.coll).estimatedDocumentCount()]] }
      case 'distinct':
        return { columns: [{ name: p.field }], rows: (await this.db(p).collection(p.coll).distinct(p.field, p.filter)).map((v) => [bsonPrint(v)]) }
      case 'command': {
        const target = this.client.db(p.admin ? 'admin' : p.db || this.cfg.database || 'test')
        return docsToResult([await target.command(p.command)])
      }
    }
  }

  /** Server-side cursors are bounded by the driver; there is no long-lived handle to interrupt here. */
  async cancel() { /* find/aggregate results are fetched to completion */ }
  async close() { await this.client?.close().catch(() => {}); this.client = undefined }
}
