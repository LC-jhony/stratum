import { describe, expect, it } from 'vitest'
import { createCassandraDialect } from '../src/main/db/cassandraDialect'
import { createSession } from '../src/main/db/factory'
import { DbSession } from '../src/main/db/session'
import { CassandraTransport, type CassandraClient, type CassandraExecuteOptions, type CassandraResultSet } from '../src/main/db/transports/cassandra'
import { cqlHead, isCassandraRead, paginateCassandraStatement, parseCassandraPage, parseCassandraUse } from '../src/core/cassandra'
import { KINDS, isSqlKind } from '../src/core/kinds'
import type { ConnectionConfig } from '../src/shared/types'

/**
 * The Cassandra console is only as safe as this allowlist and only as useful as these mappings,
 * so both are pinned here against a fake driver that speaks the two system_schema reads the
 * transport uses. No cluster (and no socket) is involved.
 */

const cfg = (extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({ id: 'cass', name: 'cass', kind: 'cassandra', host: '127.0.0.1', port: 9042, ...extra })

/* ------------------------------------------------------------------ fake driver */

type Row = Record<string, unknown>

const result = (rows: Row[], columns: string[]): CassandraResultSet => ({
  columns: columns.map((name) => ({ name })),
  rows,
  pageState: null,
  async *[Symbol.asyncIterator]() { yield* rows },
})

const keyspaces: Row[] = [{ keyspace_name: 'system' }, { keyspace_name: 'stratum_t' }]
const tables: Row[] = [
  { keyspace_name: 'system', table_name: 'local' },
  { keyspace_name: 'stratum_t', table_name: 'users' },
  { keyspace_name: 'stratum_t', table_name: 'events' },
]
const columns: Row[] = [
  { keyspace_name: 'stratum_t', table_name: 'users', column_name: 'id', kind: 'partition_key', position: 0, type: 'uuid' },
  { keyspace_name: 'stratum_t', table_name: 'users', column_name: 'ts', kind: 'clustering_key', position: 0, type: 'timestamp' },
  { keyspace_name: 'stratum_t', table_name: 'users', column_name: 'name', kind: 'regular', position: -1, type: 'text' },
  { keyspace_name: 'stratum_t', table_name: 'users', column_name: 'age', kind: 'regular', position: -1, type: 'int' },
  { keyspace_name: 'stratum_t', table_name: 'events', column_name: 'id', kind: 'partition_key', position: 0, type: 'uuid' },
  { keyspace_name: 'stratum_t', table_name: 'events', column_name: 'payload', kind: 'regular', position: -1, type: 'text' },
  { keyspace_name: 'system', table_name: 'local', column_name: 'release_version', kind: 'regular', position: -1, type: 'text' },
]
const users: Row[] = Array.from({ length: 12 }, (_, i) => ({ id: `id-${i}`, ts: `2026-10-18T10:${String(i).padStart(2, '0')}:00Z`, name: `user ${i}`, age: 20 + i }))

class FakeCassandra implements CassandraClient {
  calls: { query: string; params: unknown[]; options: CassandraExecuteOptions }[] = []
  connected = 0
  shutdowns = 0

  async connect() { this.connected++ }
  async shutdown() { this.shutdowns++ }

  async execute(query: string, params: unknown[] = [], options: CassandraExecuteOptions = {}): Promise<CassandraResultSet> {
    this.calls.push({ query, params, options })
    const q = query.trim()
    if (/^SELECT release_version FROM system\.local$/i.test(q)) return result([{ release_version: '4.1.3' }], ['release_version'])
    if (/^SELECT keyspace_name FROM system_schema\.keyspaces/i.test(q)) {
      const rows = params.length ? keyspaces.filter((r) => r.keyspace_name === params[0]) : keyspaces
      return result(rows, ['keyspace_name'])
    }
    if (/^SELECT keyspace_name, table_name FROM system_schema\.tables/i.test(q)) return result(tables, ['keyspace_name', 'table_name'])
    if (/^SELECT keyspace_name, table_name, column_name, kind, position, type FROM system_schema\.columns/i.test(q)) {
      return result(columns, ['keyspace_name', 'table_name', 'column_name', 'kind', 'position', 'type'])
    }
    if (/^SELECT column_name, kind, position, type FROM system_schema\.columns/i.test(q)) {
      const [keyspace, table] = params as string[]
      return result(columns.filter((r) => r.keyspace_name === keyspace && r.table_name === table), ['column_name', 'kind', 'position', 'type'])
    }
    if (/^SELECT \* FROM "stratum_t"\."users"$/i.test(q)) return result(users, ['id', 'ts', 'name', 'age'])
    if (/boom/i.test(q)) throw new Error('unconfigured table boom')
    return result([], [])
  }
}

const make = (extra: Partial<ConnectionConfig> = {}) => {
  const fake = new FakeCassandra()
  const transport = new CassandraTransport(cfg(extra), () => fake)
  return { fake, transport, session: new DbSession(cfg(extra), transport, createCassandraDialect(transport)) }
}

/* ------------------------------------------------------------------ text rules */

describe('cassandra statements', () => {
  it('classifies the first keyword past comments and whitespace', () => {
    expect(cqlHead('  select * from t')).toBe('SELECT')
    expect(cqlHead('-- note\nDELETE FROM t')).toBe('DELETE')
    expect(cqlHead('/* block */\n  use ks')).toBe('USE')
    expect(cqlHead('// note\nDESCRIBE TABLES')).toBe('DESCRIBE')
  })

  it('accepts SELECT, USE and DESCRIBE; rejects mutations', () => {
    for (const s of ['SELECT * FROM ks.t', 'USE "Main"', 'DESCRIBE TABLES', '  -- comment\nSELECT 1']) expect(isCassandraRead(s), s).toBe(true)
    for (const s of ['INSERT INTO t (a) VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t WHERE a = 1', 'TRUNCATE t', 'CREATE TABLE t (a int)',
      'ALTER TABLE t ADD b int', 'DROP TABLE t', 'BEGIN BATCH INSERT INTO t (a) VALUES (1); APPLY BATCH', '-- x\nDELETE FROM t']) {
      expect(isCassandraRead(s), s).toBe(false)
    }
  })

  it('wraps reads in the paging header and parses it back', () => {
    expect(paginateCassandraStatement('SELECT * FROM k.t', 501, 1000)).toBe('PAGE 1000 501\nSELECT * FROM k.t')
    expect(paginateCassandraStatement('USE ks', 501, 0)).toBe('PAGE 0 501\nUSE ks')
    expect(paginateCassandraStatement('INSERT INTO t (a) VALUES (1)', 501, 0)).toBeUndefined()
    expect(parseCassandraPage('PAGE 1000 501\nSELECT * FROM k.t')).toEqual({ offset: 1000, limit: 501, cql: 'SELECT * FROM k.t' })
    expect(parseCassandraPage('SELECT * FROM k.t')).toBeUndefined()
  })

  it('parses USE with CQL folding rules', () => {
    expect(parseCassandraUse('USE events')).toBe('events')
    expect(parseCassandraUse('use Events;')).toBe('events')
    expect(parseCassandraUse('USE "Main"')).toBe('Main')
    expect(parseCassandraUse('USE "a""b"')).toBe('a"b')
    expect(parseCassandraUse('SELECT 1')).toBeUndefined()
    expect(parseCassandraUse('USE a.b')).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ transport */

describe('cassandra transport', () => {
  it('connects, reports the release version and rejects bad contact points', async () => {
    const { transport, fake } = make()
    await transport.open()
    expect(fake.connected).toBe(1)
    expect(await transport.open()).toEqual({ version: '4.1.3' }) // idempotent for the fake

    const broken = new CassandraTransport(cfg(), () => ({ connect: async () => { throw new Error('ECONNREFUSED') }, execute: async () => result([], []), shutdown: async () => undefined }))
    await expect(broken.open()).rejects.toThrow(/Cassandra connection to 127\.0\.0\.1:9042 failed: ECONNREFUSED/)
  })

  it('introspects keyspaces, tables and primary-key-first columns', async () => {
    const { session, transport } = make()
    await transport.open()
    const m = await session.introspect()
    expect(m.kind).toBe('cassandra')
    expect(isSqlKind('cassandra')).toBe(false)
    expect(KINDS.cassandra.defaultPort).toBe(9042)
    expect(m.schemas.map((s) => s.name)).toEqual(['stratum_t', 'system'])
    expect(m.schemas.find((s) => s.name === 'stratum_t')!.tables.map((t) => t.name)).toEqual(['events', 'users'])
    const usersTable = m.schemas.find((s) => s.name === 'stratum_t')!.tables.find((t) => t.name === 'users')!
    expect(usersTable.columns.map((c) => `${c.name}:${c.dataType}:${c.isPrimaryKey ? 'pk' : c.nullable ? 'null' : 'no'}`)).toEqual(['id:uuid:pk', 'ts:timestamp:pk', 'age:int:null', 'name:text:null'])
  })

  it('pages reads through the PAGE header, walking from the first row', async () => {
    const { session, fake } = make()
    const first = await session.execute('SELECT * FROM "stratum_t"."users"', { limit: 5 })
    expect(first.error).toBeUndefined()
    expect(first.rows).toHaveLength(5)
    expect(first.hasMore).toBe(true)
    expect(first.rows[0]).toEqual(['id-0', '2026-10-18T10:00:00Z', 'user 0', 20])
    expect(fake.calls.at(-1)!.query).toBe('SELECT * FROM "stratum_t"."users"')
    expect(fake.calls.at(-1)!.options).toMatchObject({ fetchSize: 6, prepare: false })

    const last = await session.execute('SELECT * FROM "stratum_t"."users"', { limit: 5, offset: 10 })
    expect(last.rows).toHaveLength(2)
    expect(last.hasMore).toBe(false)
    expect(fake.calls.at(-1)!.options.fetchSize).toBe(16)
  })

  it('tracks USE as session state and applies it to later queries', async () => {
    const { session, fake } = make()
    const use = await session.execute('USE stratum_t')
    expect(use.error).toBeUndefined()
    expect(use.rows).toEqual([])
    await session.execute('SELECT * FROM users', { limit: 2 })
    expect(fake.calls.at(-1)!.options.keyspace).toBe('stratum_t')
    expect((await session.execute('USE nope')).error).toMatch(/Keyspace "nope" does not exist/)
  })

  it('serves DESCRIBE KEYSPACES, TABLES and TABLE', async () => {
    const { session, fake } = make()
    const ks = await session.execute('DESCRIBE KEYSPACES')
    expect(ks.rows.map((r) => r[0])).toEqual(['system', 'stratum_t'])

    const tbls = await session.execute('DESCRIBE TABLES')
    expect(tbls.columns.map((c) => c.name)).toEqual(['keyspace_name', 'table_name'])
    expect(tbls.rows).toHaveLength(3)

    const cols = await session.execute('DESCRIBE TABLE stratum_t.users')
    expect(cols.columns.map((c) => c.name)).toEqual(['column_name', 'kind', 'position', 'type'])
    expect(cols.rows.map((r) => r[0])).toEqual(['id', 'ts', 'name', 'age'])

    expect((await session.execute('DESCRIBE FULL')).error).toMatch(/DESCRIBE supports KEYSPACES, TABLES or TABLE/)
    expect((await session.execute('DESCRIBE TABLE users')).error).toMatch(/DESCRIBE TABLE needs a keyspace/)

    await session.execute('USE stratum_t')
    const unqualified = await session.execute('DESCRIBE TABLE users')
    expect(unqualified.error).toBeUndefined()
    expect(fake.calls.at(-1)!.params).toEqual(['stratum_t', 'users'])
  })

  it('rejects writes (and PAGE-smuggled writes) before the driver sees them', async () => {
    const { session, transport, fake } = make()
    const before = fake.calls.length
    for (const stmt of ['INSERT INTO t (a) VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t WHERE a = 1', 'TRUNCATE t',
      'CREATE TABLE t (a int)', 'ALTER TABLE t ADD b int', 'DROP KEYSPACE k', 'BEGIN BATCH INSERT INTO t (a) VALUES (1); APPLY BATCH', '-- x\nDELETE FROM t']) {
      expect((await session.execute(stmt)).error, stmt).toMatch(/read-only/)
    }
    await expect(transport.query('PAGE 0 10\nDELETE FROM t')).rejects.toThrow(/read-only/)
    expect(fake.calls.length).toBe(before)
  })

  it('keeps reads working on read-only sources and gates the rest', async () => {
    const { session } = make({ readonly: true })
    expect((await session.execute('SELECT * FROM "stratum_t"."users"', { limit: 2 })).error).toBeUndefined()
    expect((await session.execute('INSERT INTO t (a) VALUES (1)')).error).toMatch(/Data source is read-only/)
  })

  it('maps driver errors into the results pane', async () => {
    const { session } = make()
    expect((await session.execute('SELECT * FROM boom')).error).toMatch(/unconfigured table boom/)
  })

  it('is registered in the factory with the cassandra dialect', () => {
    const s = createSession(cfg())
    expect(s.dialect.id).toBe('cassandra')
    expect(s.config.kind).toBe('cassandra')
  })
})
