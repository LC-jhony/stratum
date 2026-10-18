import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMongoDialect } from '../src/main/db/mongoDialect'
import { DbSession } from '../src/main/db/session'
import { MongoTransport } from '../src/main/db/transports/mongodb'
import type { ConnectionConfig } from '../src/shared/types'

/**
 * Live MongoDB checks — skipped unless a server is provided:
 *
 *   STRATUM_TEST_MONGODB_URI=mongodb://localhost:27017   against any running mongod
 *   STRATUM_TEST_MONGODB_MEMORY=1                        spawns an ephemeral one
 *                                                        (needs `npm i -D mongodb-memory-server`)
 *
 * The seed data is written with the official driver directly: the transport under test is
 * read-only by design, so it cannot prepare its own fixtures.
 */
const provided = process.env.STRATUM_TEST_MONGODB_URI
const memory = process.env.STRATUM_TEST_MONGODB_MEMORY === '1'
const suite = provided || memory ? describe : describe.skip

const DB = 'stratum_test'
const cfg: ConnectionConfig = { id: 'live', name: 'live', kind: 'mongodb', host: 'localhost', port: 27017, database: DB }

suite('mongodb live', () => {
  let s: DbSession
  let stopServer: (() => Promise<void>) | undefined

  beforeAll(async () => {
    let uri = provided
    if (!uri) {
      const { MongoMemoryServer } = await import('mongodb-memory-server')
      const server = await MongoMemoryServer.create()
      uri = server.getUri(DB)
      stopServer = async () => { await server.stop() }
    }
    cfg.uri = uri
    const { MongoClient } = await import('mongodb')
    const client = new MongoClient(uri)
    try {
      await client.connect()
      const db = client.db(DB)
      await db.collection('users').insertMany([
        { name: 'ada', age: 36, country: 'uk', active: true, nested: { plan: 'pro' } },
        { name: 'grace', age: 45, country: 'us', active: true },
        { name: 'linus', age: 54, country: 'fi', active: false },
        ...Array.from({ length: 30 }, (_, i) => ({ name: `u${i}`, age: 20 + i, active: i % 2 === 0 })),
      ])
      await db.collection('events').createIndex({ name: 1 }, { unique: true })
      await db.collection('events').insertOne({ name: 'boot', at: new Date() })
      await db.createCollection('active_users', { viewOn: 'users', pipeline: [{ $match: { active: true } }] })
    } finally { await client.close() }
    s = new DbSession(cfg, new MongoTransport(cfg), createMongoDialect(cfg))
    await s.open()
  }, 120_000)
  afterAll(async () => { await s?.close(); await stopServer?.() })

  it('connects and reports the server version', () => {
    expect(s.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('introspects databases, collections, sampled fields, views and indexes', async () => {
    const m = await s.introspect()
    expect(m.kind).toBe('mongodb')
    const db = m.schemas.find((x) => x.name === DB)
    expect(db).toBeDefined()
    const table = (n: string) => db!.tables.find((t) => t.name === n)!
    expect(db!.tables.map((t) => t.name)).toEqual(expect.arrayContaining(['users', 'events', 'active_users']))
    expect(table('active_users').kind).toBe('view')
    expect(table('users').columns.map((c) => c.name)).toEqual(expect.arrayContaining(['_id', 'name', 'age', 'country', 'active']))
    expect(table('users').columns.find((c) => c.name === '_id')!.isPrimaryKey).toBe(true)
    expect(table('users').columns.find((c) => c.name === 'nested')!.dataType).toBe('object')
    expect(table('events').indexes.map((i) => i.name)).toEqual(expect.arrayContaining(['_id_', 'name_1']))
    expect(table('events').indexes.find((i) => i.name === 'name_1')!.unique).toBe(true)
  })

  it('pages finds like SQL sources do', async () => {
    const a = await s.execute('db.users.find({})', { limit: 10 })
    expect(a.columns[0].name).toBe('_id')
    expect(a.rows).toHaveLength(10)
    expect(a.hasMore).toBe(true)
    const last = await s.execute('db.users.find({})', { limit: 10, offset: 30 })
    expect(last.rows).toHaveLength(3)
    expect(last.hasMore).toBe(false)
  })

  it('runs filters, sort, project, aggregate, count and distinct', async () => {
    const f = await s.execute(`db.users.find({age:{$gt:50}}, {name:1, _id:0}).sort({age:1})`)
    expect(f.rows.map((r) => r[0])).toEqual(['linus'])
    const oid = await s.execute(`db.users.findOne({name:"ada"})`)
    expect(oid.rows).toHaveLength(1)
    const a = await s.execute(`db.users.aggregate([{$match:{active:true}},{$count:"n"}])`)
    expect(a.rows[0][0]).toBeGreaterThan(10)
    const c = await s.execute(`db.users.countDocuments({active:true})`)
    expect(c.rows[0][0]).toBeGreaterThan(10)
    const d = await s.execute(`db.users.distinct("country")`)
    expect(d.rows.flat()).toEqual(expect.arrayContaining(['uk', 'us', 'fi']))
  })

  it('targets other databases through getSiblingDB', async () => {
    const r = await s.execute(`db.getSiblingDB("admin").runCommand({ buildInfo: 1 })`)
    expect(String(r.rows[0][r.columns.findIndex((c) => c.name === 'version')])).toMatch(/^\d+\.\d+/)
  })

  it('rejects writes with a clear message and keeps reads working on read-only sources', async () => {
    expect((await s.execute(`db.users.deleteMany({})`)).error).toMatch(/Unsupported MongoDB operation/)
    expect((await s.execute(`db.users.find({}).explain()`)).error).toMatch(/Unsupported MongoDB cursor method/)
    const ro: ConnectionConfig = { ...cfg, id: 'ro', readonly: true }
    const sro = new DbSession(ro, new MongoTransport(ro), createMongoDialect(ro))
    await sro.open()
    expect((await sro.execute(`db.users.find({})`)).rows.length).toBeGreaterThan(0)
    expect((await sro.execute(`db.runCommand({ listDatabases: 1 })`)).error).toMatch(/read-only/i)
    await sro.close()
  })
})
