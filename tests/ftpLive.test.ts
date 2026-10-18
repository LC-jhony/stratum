import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSession } from '../src/main/db/factory'
import type { DbSession } from '../src/main/db/session'
import type { JdbcSidecar } from '../src/main/services/jdbcSidecar'
import type { ConnectionConfig } from '../src/shared/types'

/**
 * Live FTP checks — skipped unless a server is provided:
 *
 *   STRATUM_TEST_FTP_HOST=127.0.0.1           required; must allow listing the chosen path
 *   STRATUM_TEST_FTP_PORT=21                  optional (default 21)
 *   STRATUM_TEST_FTP_USER / _PASSWORD         optional (anonymous otherwise)
 *   STRATUM_TEST_FTP_SECURE=1                 explicit FTPS (AUTH TLS)
 *   STRATUM_TEST_FTP_PATH=/pub                optional directory to list (default /)
 *
 * The suite only logs in and lists directories, so it is safe on shared servers; it never uploads,
 * renames or deletes.
 */
const host = process.env.STRATUM_TEST_FTP_HOST
const suite = host ? describe : describe.skip

const path = process.env.STRATUM_TEST_FTP_PATH || '/'
const cfg: ConnectionConfig = {
  id: 'ftp-live',
  name: 'ftp-live',
  kind: 'ftp',
  host,
  port: process.env.STRATUM_TEST_FTP_PORT ? Number(process.env.STRATUM_TEST_FTP_PORT) : 21,
  user: process.env.STRATUM_TEST_FTP_USER,
  password: process.env.STRATUM_TEST_FTP_PASSWORD,
  ssl: process.env.STRATUM_TEST_FTP_SECURE === '1',
}

suite('FTP live', () => {
  let s: DbSession

  beforeAll(async () => {
    s = createSession(cfg, {} as JdbcSidecar)
    await s.open()
  })

  afterAll(async () => { await s?.close().catch(() => undefined) })

  it('introspects the root folders', async () => {
    const m = await s.introspect()
    expect(m.kind).toBe('ftp')
    expect(m.schemas.map((x) => x.name)).toEqual(['files'])
    expect(m.schemas[0].tables.map((t) => t.name)).toContain('(root)')
  })

  it('lists a directory read-only, with paging', async () => {
    const r = await s.execute(`LIST ${JSON.stringify(path)}`, { limit: 5 })
    expect(r.error).toBeUndefined()
    expect(r.columns.map((c) => c.name)).toEqual(['name', 'type', 'size', 'modified', 'permissions'])
    expect(r.rows.length).toBeLessThanOrEqual(5)
    expect(r.rows.every((row) => typeof row[0] === 'string' && ['file', 'folder', 'link'].includes(String(row[1])))).toBe(true)
  })

  it('has no console: other statements are refused locally', async () => {
    for (const stmt of ['SELECT * FROM x', 'DELETE /file', 'PUT /file']) {
      const r = await s.execute(stmt)
      expect(r.error, stmt).toMatch(/FTP has no query console/)
    }
  })
})
