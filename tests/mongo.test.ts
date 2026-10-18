import { describe, expect, it } from 'vitest'
import { Long, ObjectId } from 'mongodb'
import { bsonPrint, docsToResult, isMongoRead, paginateMongoStatement, parseMongoStatement } from '../src/main/db/transports/mongodb'
import { KINDS, isSqlKind } from '../src/shared/kinds'
import { mongoStatementAt, splitMongoStatements } from '../src/shared/mongo'

const oid = (n: number) => new ObjectId(`${n}`.padStart(24, '0'))

describe('mongosh statement parser', () => {
  it('parses find with chain methods and JS-ish arguments', () => {
    const s = parseMongoStatement(`db.users.find({age:{$gt:30}, tag:'a'}, {name:1}).sort({age:-1}).skip(20).limit(50);`)
    expect(s).toMatchObject({
      op: 'find', db: '', coll: 'users',
      filter: { age: { $gt: 30 }, tag: 'a' },
      projection: { name: 1 },
      sort: { age: -1 }, skip: 20, limit: 50,
    })
  })
  it('parses getSiblingDB/getCollection, bracket access and views', () => {
    expect(parseMongoStatement(`db.getSiblingDB("sales").getCollection("logs-2024").find({})`)).toMatchObject({ op: 'find', db: 'sales', coll: 'logs-2024' })
    expect(parseMongoStatement(`db["my-coll"].findOne({x:1})`)).toMatchObject({ op: 'find', coll: 'my-coll', limit: 1 })
    expect(parseMongoStatement(`db.orders.aggregate([{$match:{a:1}},{$group:{_id:"$s",n:{$sum:1}}}]).pretty()`)).toMatchObject({ op: 'aggregate', coll: 'orders' })
    expect(parseMongoStatement(`db.users.countDocuments({active:true})`)).toMatchObject({ op: 'count', filter: { active: true } })
    expect(parseMongoStatement(`db.users.estimatedDocumentCount()`)).toMatchObject({ op: 'estimatedCount' })
    expect(parseMongoStatement(`db.users.distinct("country", {active:true})`)).toMatchObject({ op: 'distinct', field: 'country' })
    expect(parseMongoStatement(`db.adminCommand({ listDatabases: 1 })`)).toMatchObject({ op: 'command', admin: true })
    expect(parseMongoStatement(`db.getSiblingDB("admin").runCommand({ buildInfo: 1 })`)).toMatchObject({ op: 'command', admin: false, db: 'admin' })
  })
  it('builds BSON values from the shell constructors', () => {
    const s = parseMongoStatement(`db.t.find({_id: ObjectId("5f1fbc0a1a2b3c4d5e6f7a8b"), at: ISODate("2024-01-02T03:04:05Z"), n: NumberLong(42)})`)
    const filter = (s as { filter: Record<string, unknown> }).filter
    expect(filter._id).toBeInstanceOf(ObjectId)
    expect(filter.at).toBeInstanceOf(Date)
    expect(String(filter.n)).toBe('42')
  })
  it('rejects writes, JS and unknown cursor methods with a clear message', () => {
    expect(() => parseMongoStatement(`db.users.deleteMany({})`)).toThrow(/Unsupported MongoDB operation "deleteMany/)
    expect(() => parseMongoStatement(`db.dropDatabase()`)).toThrow(/Unsupported MongoDB operation "dropDatabase/)
    expect(() => parseMongoStatement(`db.users.find({}).explain()`)).toThrow(/Unsupported MongoDB cursor method/)
    expect(() => parseMongoStatement(`db.users.find({}).map(x => x)`)).toThrow(/unknown value/)
    expect(() => parseMongoStatement(`whatever()`)).toThrow(/only expressions starting with "db\."/)
    expect(() => parseMongoStatement(`db.users.find({a:})`)).toThrow(/Cannot parse MongoDB statement/)
  })
})

describe('mongosh paging and read detection', () => {
  it('pages plain finds and leaves user limits alone', () => {
    expect(paginateMongoStatement(`db.users.find({age:{$gt:30}})`, 501, 0)).toBe(`db.users.find({age:{$gt:30}}).skip(0).limit(501)`)
    expect(paginateMongoStatement(`db.users.find({}).limit(3)`, 501, 0)).toBeUndefined()
    expect(paginateMongoStatement(`db.orders.aggregate([])`, 501, 0)).toBeUndefined()
    expect(paginateMongoStatement(`db.users.countDocuments({})`, 501, 0)).toBeUndefined()
  })
  it('classifies reads and commands', () => {
    expect(isMongoRead(`db.users.find({})`)).toBe(true)
    expect(isMongoRead(`db.orders.aggregate([])`)).toBe(true)
    expect(isMongoRead(`db.users.deleteMany({})`)).toBe(false)
    expect(isMongoRead(`db.runCommand({dropDatabase:1})`)).toBe(false)
    expect(isMongoRead(`db.users.find({`)).toBe(false)
  })
})

describe('documents to grid rows', () => {
  it('unions top-level keys, puts _id first and fills gaps with null', () => {
    const r = docsToResult([
      { name: 'a', _id: oid(1), nested: { x: 1 } },
      { _id: oid(2), age: 30 },
    ])
    expect(r.columns.map((c) => c.name)).toEqual(['_id', 'name', 'nested', 'age'])
    expect(r.rows[0]).toEqual([oid(1).toHexString(), 'a', { x: 1 }, null])
    expect(r.rows[1]).toEqual([oid(2).toHexString(), null, null, 30])
  })
  it('prints BSON leaves safely', () => {
    expect(bsonPrint(new ObjectId('5f1fbc0a1a2b3c4d5e6f7a8b'))).toBe('5f1fbc0a1a2b3c4d5e6f7a8b')
    expect(bsonPrint(Long.fromString('42'))).toBe('42')
    const d = new Date('2024-01-02T03:04:05Z')
    expect(bsonPrint(d)).toBe(d)
    expect(bsonPrint({ a: [new ObjectId('5f1fbc0a1a2b3c4d5e6f7a8b')] })).toEqual({ a: ['5f1fbc0a1a2b3c4d5e6f7a8b'] })
  })
})

describe('console statement splitter', () => {
  it('splits on top-level semicolons and on new db. expressions', () => {
    const text = `db.users.find({name:"a;b"})\ndb.orders.find({})\ndb.a.find({}); db.b.find({})\n`
    const all = splitMongoStatements(text)
    expect(all.map((s) => s.text)).toEqual([
      `db.users.find({name:"a;b"})`,
      `db.orders.find({})`,
      `db.a.find({})`,
      `db.b.find({})`,
    ])
  })
  it('never splits inside documents spread over lines', () => {
    const text = `db.orders.find({\n  status: "open",\n  lines: [{q:1}]\n}).sort({at:-1})`
    expect(splitMongoStatements(text)).toHaveLength(1)
  })
  it('statementAt picks the block under the caret', () => {
    const text = `db.users.find({})\ndb.orders.find({})\n`
    expect(mongoStatementAt(text, text.indexOf('orders'))?.text).toBe(`db.orders.find({})`)
  })
})

describe('provider capabilities', () => {
  it('marks mongodb as non-SQL and defaults to SQL for unknown kinds', () => {
    expect(KINDS.mongodb.sql).toBe(false)
    expect(KINDS.mongodb.defaultPort).toBe(27017)
    expect(isSqlKind('mongodb')).toBe(false)
    expect(isSqlKind('postgres')).toBe(true)
    expect(isSqlKind(undefined)).toBe(true)
  })
})
