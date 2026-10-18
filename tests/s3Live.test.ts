import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSession } from '../src/main/db/factory'
import type { DbSession } from '../src/main/db/session'
import type { ConnectionConfig } from '../src/shared/types'

/**
 * Live S3 checks — skipped unless a bucket is provided:
 *
 *   STRATUM_TEST_S3_BUCKET=my-bucket              required, must be listable with the credentials
 *   STRATUM_TEST_S3_ENDPOINT=host[:port]          optional S3-compatible endpoint (MinIO, R2…)
 *   STRATUM_TEST_S3_REGION=us-east-1              optional region
 *   STRATUM_TEST_S3_ACCESS_KEY / _SECRET_KEY      optional credentials (default chain otherwise)
 *   STRATUM_TEST_S3_SSL=1                         use https on a custom endpoint
 *
 * The suite only lists buckets and objects, so it is safe on shared storage; it never writes.
 */
const bucket = process.env.STRATUM_TEST_S3_BUCKET
const suite = bucket ? describe : describe.skip

const endpoint = process.env.STRATUM_TEST_S3_ENDPOINT ?? ''
const endpointUrl = /^https?:\/\//.test(endpoint) ? new URL(endpoint) : undefined
const [host, port] = (endpointUrl?.host ?? endpoint).split(':')

const cfg: ConnectionConfig = {
  id: 's3-live',
  name: 's3-live',
  kind: 's3',
  host: host || undefined,
  port: port ? Number(port) : undefined,
  region: process.env.STRATUM_TEST_S3_REGION || 'us-east-1',
  user: process.env.STRATUM_TEST_S3_ACCESS_KEY,
  password: process.env.STRATUM_TEST_S3_SECRET_KEY,
  ssl: endpointUrl ? endpointUrl.protocol === 'https:' : process.env.STRATUM_TEST_S3_SSL === '1',
}

suite('S3 live', () => {
  let s: DbSession

  beforeAll(async () => {
    s = createSession(cfg)
    await s.open()
  })

  afterAll(async () => { await s?.close().catch(() => undefined) })

  it('connects and lists the configured bucket', async () => {
    const m = await s.introspect()
    expect(m.kind).toBe('s3')
    expect(m.schemas.map((x) => x.name)).toContain(bucket)
    for (const schema of m.schemas) expect(schema.tables.map((t) => t.name)).toEqual(['objects'])
  })

  it('lists objects read-only, with paging', async () => {
    const first = await s.execute(`LIST ${JSON.stringify(bucket)}`, { limit: 5 })
    expect(first.error).toBeUndefined()
    expect(first.columns.map((c) => c.name)).toEqual(['key', 'kind', 'size', 'lastModified', 'storageClass'])
    expect(first.rows.length).toBeLessThanOrEqual(5)
    expect(first.rows.every((row) => typeof row[0] === 'string' && (row[1] === 'object' || row[1] === 'folder'))).toBe(true)
  })

  it('has no console: other statements are refused locally', async () => {
    for (const stmt of ['SELECT * FROM x', 'DELETE /bucket', 'PUT key']) {
      const r = await s.execute(stmt)
      expect(r.error, stmt).toMatch(/S3 has no query console/)
    }
  })
})
