import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Redis as RedisClient } from 'ioredis'
import { createSession } from '../src/main/db/factory'
import type { DbSession } from '../src/main/db/session'
import type { ConnectionConfig } from '../src/shared/types'

/**
 * Live Redis checks — skipped unless a server is provided:
 *
 *   STRATUM_TEST_REDIS_URI=redis://localhost:6379   against any running server
 *   STRATUM_TEST_REDIS_MEMORY=1                     spawns an ephemeral one
 *                                                   (needs `npm i --no-save redis-memory-server`)
 *
 * Keys are namespaced under `stratum:t:` and never flushed on a shared server, so the suite can run
 * against a real instance without touching its data.
 */
const provided = process.env.STRATUM_TEST_REDIS_URI
const memory = process.env.STRATUM_TEST_REDIS_MEMORY === '1'
const suite = provided || memory ? describe : describe.skip

const P = 'stratum:t:'
const key = (name: string) => P + name

suite('redis live', () => {
  let s: DbSession
  let seed: RedisClient
  let stopServer: (() => Promise<void>) | undefined

  beforeAll(async () => {
    const { Redis } = await import('ioredis')
    if (provided) seed = new Redis(provided)
    else {
      const { RedisMemoryServer } = await import('redis-memory-server')
      const server = await RedisMemoryServer.create()
      seed = new Redis({ host: await server.getHost(), port: await server.getPort() })
      stopServer = async () => { await server.stop() }
    }
    await seed.set(key('greeting'), 'hola')
    await seed.hset(key('user:1'), { name: 'ada', age: '36' })
    await seed.rpush(key('list:12'), ...Array.from({ length: 12 }, (_, i) => `item${i}`))
    await seed.sadd(key('set:a'), 'm1', 'm2', 'm3')
    await seed.zadd(key('zset:1'), 1, 'a', 2, 'b', 3, 'c')
    await seed.xadd(key('stream:1'), '*', 'f', 'v')
    await seed.xadd(key('stream:1'), '*', 'f', 'w')
    const db2 = seed.duplicate({ db: 2 })
    await db2.set(key('other-db'), '1')
    await db2.quit()

    const cfg: ConnectionConfig = provided
      ? { id: 'redis-live', name: 'redis-live', kind: 'redis', uri: provided }
      : { id: 'redis-live', name: 'redis-live', kind: 'redis', host: seed.options.host, port: seed.options.port }
    s = createSession(cfg)
    await s.open()
  }, 120_000)

  afterAll(async () => {
    await s?.close().catch(() => undefined)
    await seed?.quit().catch(() => undefined)
    await stopServer?.()
  })

  it('connects and reports the server version', () => {
    expect(s.version).toMatch(/^\d+\.\d+/)
  })

  it('introspects databases as schemas and sampled keys as tables with their type', async () => {
    const m = await s.introspect()
    expect(m.kind).toBe('redis')
    const db0 = m.schemas.find((x) => x.name === 'db0')
    const db2 = m.schemas.find((x) => x.name === 'db2')
    expect(db0 && db2).toBeTruthy()
    expect(db0!.tables.map((t) => t.name)).toEqual([...db0!.tables.map((t) => t.name)].sort())
    const hash = db0!.tables.find((t) => t.name === key('user:1'))!
    expect(hash.columns[0]).toMatchObject({ name: 'type', dataType: 'hash' })
    expect(db0!.tables.find((t) => t.name === key('list:12'))!.columns[0].dataType).toBe('list')
    expect(db2!.tables.map((t) => t.name)).toContain(key('other-db'))
  })

  it('runs read commands and maps every common reply shape', async () => {
    expect((await s.execute(`GET ${key('greeting')}`)).rows).toEqual([['hola']])
    const full = await s.execute(`HGETALL ${key('user:1')}`)
    expect(full.columns.map((c) => c.name)).toEqual(['field', 'value'])
    expect(full.rows).toEqual(expect.arrayContaining([['name', 'ada'], ['age', '36']]))
    expect((await s.execute(`LRANGE ${key('list:12')} 0 -1`)).rows).toHaveLength(12)
    expect((await s.execute(`SMEMBERS ${key('set:a')}`)).rows).toEqual(expect.arrayContaining([['m1'], ['m2']]))
    const z = await s.execute(`ZRANGE ${key('zset:1')} 0 -1 WITHSCORES`)
    expect(z.rows).toEqual([['a', '1'], ['b', '2'], ['c', '3']])
    const scan = await s.execute(`SCAN 0 MATCH ${key('greeting')} COUNT 100`)
    expect(scan.columns.map((c) => c.name)).toEqual(['cursor', 'key'])
    expect(scan.rows).toEqual(expect.arrayContaining([[expect.any(String), key('greeting')]]))
    expect((await s.execute(`TTL ${key('greeting')}`)).rows).toEqual([[-1]])
  })

  it('rejects writes, admin and blocking commands before they reach the server', async () => {
    for (const stmt of [`SET ${key('x')} 1`, `DEL ${key('greeting')}`, 'FLUSHALL', 'CONFIG GET databases', 'EVAL "return 1" 0', 'SUBSCRIBE ch']) {
      const r = await s.execute(stmt)
      expect(r.error, stmt).toMatch(/read-only/)
    }
    expect((await s.execute(`GET ${key('greeting')}`)).rows).toEqual([['hola']]) // still intact
  })

  it('pages key values through the INSPECT reader used by the grid', async () => {
    const first = await s.execute(`INSPECT ${JSON.stringify(key('list:12'))}`, { limit: 5 })
    expect(first.columns.map((c) => c.name)).toEqual(['index', 'value'])
    expect(first.rows).toEqual([[0, 'item0'], [1, 'item1'], [2, 'item2'], [3, 'item3'], [4, 'item4']])
    expect(first.hasMore).toBe(true)
    const last = await s.execute(`INSPECT ${JSON.stringify(key('list:12'))}`, { limit: 5, offset: 10 })
    expect(last.rows).toEqual([[10, 'item10'], [11, 'item11']])
    expect(last.hasMore).toBe(false)

    const hash = await s.execute(`INSPECT ${JSON.stringify(key('user:1'))}`, { limit: 1, offset: 1 })
    expect(hash.columns.map((c) => c.name)).toEqual(['field', 'value'])
    expect(hash.rows).toHaveLength(1)

    const stream = await s.execute(`INSPECT ${JSON.stringify(key('stream:1'))}`, { limit: 10 })
    expect(stream.columns.map((c) => c.name)).toEqual(['id', 'fields'])
    expect(stream.rows[0][1]).toContain('"f"')

    expect((await s.execute('INSPECT "stratum:t:missing"')).error).toMatch(/does not exist/)
  })

  it('keeps reads working on read-only sources and blocks them nothing extra', async () => {
    const cfg: ConnectionConfig = { ...s.config, id: 'redis-ro', readonly: true }
    const ro = createSession(cfg)
    await ro.open()
    expect((await ro.execute(`GET ${key('greeting')}`)).rows).toEqual([['hola']])
    expect((await ro.execute(`SET ${key('x')} 1`)).error).toMatch(/read-only/)
    await ro.close()
  })
})
