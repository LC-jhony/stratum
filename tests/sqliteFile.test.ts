import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dialects } from '../src/main/db/dialects'
import { DbSession } from '../src/main/db/session'
import { SqliteTransport } from '../src/main/db/transports/sqlite'
import type { ConnectionConfig } from '../src/shared/types'

const dir = mkdtempSync(path.join(tmpdir(), 'stratum-sqlite-'))
const file = path.join(dir, 'atomic.db')
const cfg: ConnectionConfig = { id: 's', name: 's', kind: 'sqlite', filePath: file }
let s: DbSession

beforeAll(async () => {
  s = new DbSession(cfg, new SqliteTransport(cfg), dialects.sqlite)
  await s.open()
  await s.execute('create table t (id integer primary key, v text)')
  await s.execute("insert into t (v) values ('a')")
})
afterAll(async () => { await s.close(); rmSync(dir, { recursive: true, force: true }) })

describe('SQLite file safety', () => {
  it('persists through a sibling temp file and leaves none behind', () => {
    expect(statSync(file).size).toBeGreaterThan(0)
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('refuses to overwrite a file changed by another process', async () => {
    const later = new Date(Date.now() + 5000)
    utimesSync(file, later, later)
    const r = await s.execute("insert into t (v) values ('external')")
    expect(r.error).toMatch(/changed on disk/i)
  })

  it('still reads after the external change (only writes are refused)', async () => {
    const r = await s.execute('select count(*) from t')
    expect(r.error).toBeUndefined()
    expect(r.rows[0][0]).toBeGreaterThanOrEqual(1)
  })
})
