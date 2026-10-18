import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSession } from '../src/main/db/factory'
import type { DbSession } from '../src/main/db/session'
import type { ConnectionConfig } from '../src/shared/types'

/**
 * Live Elasticsearch checks — skipped unless a cluster is provided:
 *
 *   STRATUM_TEST_ELASTIC_URL=http://localhost:9200    against any running cluster
 *   STRATUM_TEST_ELASTIC_USER / _PASSWORD             optional basic auth
 *
 * The suite is strictly read-only: it lists indices, reads mappings and searches existing data, so
 * it can run against a real cluster without changing anything. Write blocking is asserted against
 * the local allowlist (no request ever reaches the server).
 */
const url = process.env.STRATUM_TEST_ELASTIC_URL
const suite = url ? describe : describe.skip

const cfg: ConnectionConfig = {
  id: 'elastic-live',
  name: 'elastic-live',
  kind: 'elastic',
  uri: url ?? 'http://127.0.0.1:9200',
  user: process.env.STRATUM_TEST_ELASTIC_USER,
  password: process.env.STRATUM_TEST_ELASTIC_PASSWORD,
}

suite('Elasticsearch live', () => {
  let s: DbSession
  let indices: string[] = []

  beforeAll(async () => {
    s = createSession(cfg)
    await s.open()
    const r = await s.execute('GET /_cat/indices?format=json&h=index')
    indices = r.error ? [] : r.rows.map((row) => String(row[0] ?? '')).filter(Boolean)
  })

  afterAll(async () => { await s?.close().catch(() => undefined) })

  it('connects and reports the cluster version', () => {
    expect(typeof s.version).toBe('string')
    expect(s.version).toMatch(/^\d+\./)
  })

  it('lists indices through the console', async () => {
    const r = await s.execute('GET /_cat/indices?format=json&h=index')
    expect(r.error).toBeUndefined()
    expect(r.columns.map((c) => c.name)).toContain('index')
    expect(r.rows.map((row) => String(row[0]))).toEqual(indices)
  })

  it('introspects one indices schema with mapping columns', async () => {
    const m = await s.introspect()
    expect(m.kind).toBe('elastic')
    expect(m.schemas.map((x) => x.name)).toEqual(['indices'])
    expect(m.schemas[0].tables.map((t) => t.name)).toEqual(indices.slice(0, 300))
    const withColumns = m.schemas[0].tables.find((t) => t.columns.length > 0)
    if (withColumns) for (const c of withColumns.columns) { expect(c.name.length).toBeGreaterThan(0) }
  })

  it('searches existing data read-only, through SEARCH and Dev Tools', async () => {
    const index = indices.find((i) => !i.startsWith('.')) ?? indices[0]
    if (!index) return // empty cluster: nothing to search, reads still covered above

    const paged = await s.execute(`SEARCH ${JSON.stringify(index)}`, { limit: 5 })
    expect(paged.error).toBeUndefined()
    expect(paged.rows.length).toBeLessThanOrEqual(5)
    if (paged.rows.length) expect(paged.columns.length).toBeGreaterThan(0)

    const devTools = await s.execute(`GET /${index}/_search`)
    expect(devTools.error).toBeUndefined()
    expect(devTools.columns.map((c) => c.name)).toContain('_id')
  })

  it('blocks writes in the local allowlist', async () => {
    for (const stmt of ['DELETE /stratum-t-live-doc', 'PUT /stratum-t-live-doc/_doc/1', 'POST /stratum-t-live-doc/_doc', 'POST /_bulk']) {
      const r = await s.execute(stmt)
      expect(r.error, stmt).toMatch(/read-only/)
    }
  })

  it('reports a missing index as a readable error', async () => {
    const r = await s.execute('SEARCH "stratum-t-live-missing-index"')
    expect(r.error).toBeTruthy()
    expect(r.error).toMatch(/index_not_found|no such index/i)
  })
})
