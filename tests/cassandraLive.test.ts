import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSession } from '../src/main/db/factory'
import type { DbSession } from '../src/main/db/session'
import type { JdbcSidecar } from '../src/main/services/jdbcSidecar'
import type { ConnectionConfig } from '../src/shared/types'

/**
 * Live Cassandra checks — skipped unless a cluster is provided:
 *
 *   STRATUM_TEST_CASSANDRA_CONTACT=127.0.0.1[:9042]   any running node
 *   STRATUM_TEST_CASSANDRA_DC=datacenter1             local data center (default datacenter1)
 *   STRATUM_TEST_CASSANDRA_USER / _PASSWORD           optional credentials
 *   STRATUM_TEST_CASSANDRA_KEYSPACE                   optional initial keyspace
 *
 * The suite is strictly read-only: it reads `system`/`system_schema`, so it is safe on a shared
 * cluster. Write blocking is asserted against the local allowlist (no request reaches the node).
 */
const contact = process.env.STRATUM_TEST_CASSANDRA_CONTACT
const suite = contact ? describe : describe.skip

const [host, port] = (contact ?? '127.0.0.1:9042').split(':')
const cfg: ConnectionConfig = {
  id: 'cassandra-live',
  name: 'cassandra-live',
  kind: 'cassandra',
  host,
  port: port ? Number(port) : 9042,
  dataCenter: process.env.STRATUM_TEST_CASSANDRA_DC || 'datacenter1',
  user: process.env.STRATUM_TEST_CASSANDRA_USER,
  password: process.env.STRATUM_TEST_CASSANDRA_PASSWORD,
  database: process.env.STRATUM_TEST_CASSANDRA_KEYSPACE,
}

suite('Cassandra live', () => {
  let s: DbSession

  beforeAll(async () => {
    s = createSession(cfg, {} as JdbcSidecar)
    await s.open()
  })

  afterAll(async () => { await s?.close().catch(() => undefined) })

  it('connects and reports the release version', () => {
    expect(typeof s.version).toBe('string')
    expect(s.version).toMatch(/^\d+\./)
  })

  it('reads through SELECT and DESCRIBE', async () => {
    const local = await s.execute('SELECT release_version FROM system.local')
    expect(local.error).toBeUndefined()
    expect(local.rows).toHaveLength(1)

    const keyspaces = await s.execute('DESCRIBE KEYSPACES')
    expect(keyspaces.error).toBeUndefined()
    expect(keyspaces.rows.map((r) => String(r[0]))).toContain('system')

    const tables = await s.execute('DESCRIBE TABLES')
    expect(tables.error).toBeUndefined()
    expect(tables.columns.map((c) => c.name)).toEqual(['keyspace_name', 'table_name'])
  })

  it('introspects keyspaces, tables and columns', async () => {
    const m = await s.introspect()
    expect(m.kind).toBe('cassandra')
    const system = m.schemas.find((x) => x.name === 'system')
    expect(system).toBeTruthy()
    expect(system!.tables.some((t) => t.name === 'local')).toBe(true)
    const local = system!.tables.find((t) => t.name === 'local')!
    expect(local.columns.length).toBeGreaterThan(0)
  })

  it('pages reads and keeps USE as session state', async () => {
    const first = await s.execute('SELECT keyspace_name FROM system_schema.keyspaces', { limit: 2 })
    expect(first.error).toBeUndefined()
    expect(first.rows.length).toBeLessThanOrEqual(2)

    const use = await s.execute('USE system')
    expect(use.error).toBeUndefined()
    const unqualified = await s.execute('SELECT key FROM local LIMIT 1')
    expect(unqualified.error).toBeUndefined()
    expect(unqualified.rows).toHaveLength(1)
  })

  it('blocks writes in the local allowlist', async () => {
    for (const stmt of ['INSERT INTO system.local (key) VALUES (\'x\')', "UPDATE system.local SET value = 'x'", 'DELETE FROM system.local WHERE key = \'x\'', 'TRUNCATE system.local', 'DROP KEYSPACE stratum_t_live']) {
      const r = await s.execute(stmt)
      expect(r.error, stmt).toMatch(/read-only/)
    }
  })

  it('reports a missing keyspace on USE', async () => {
    const r = await s.execute('USE stratum_t_live_missing')
    expect(r.error).toMatch(/does not exist/)
  })
})
