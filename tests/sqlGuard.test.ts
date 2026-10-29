import { describe, expect, it } from 'vitest'
import { readOnlyViolation } from '../src/core/sql'
import { dialects } from '../src/main/db/dialects'
import { DbSession } from '../src/main/db/session'
import type { RawResult } from '../src/shared/types'
import type { Transport } from '../src/main/db/types'

function fake(affectedRows = 0) {
  const calls: string[] = []
  const transport: Transport = {
    open: async () => ({}),
    close: async () => undefined,
    cancel: async () => undefined,
    query: async (sql: string): Promise<RawResult> => {
      calls.push(sql)
      return { columns: [], rows: [], affectedRows }
    },
  }
  return { calls, transport }
}

const cfg = { id: 'x', name: 'x', kind: 'sqlite' as const }

describe('read-only guard', () => {
  it('detects set_config and data-modifying CTEs, ignoring strings and comments', () => {
    expect(readOnlyViolation("select set_config('work_mem', '1GB', false)")).toMatch(/set_config/)
    expect(readOnlyViolation('with x as (delete from t returning id) select * from x')).toMatch(/CTE/)
    expect(readOnlyViolation('with x as (update t set a = 1 returning *) select * from x')).toMatch(/CTE/)
    expect(readOnlyViolation('with x as (insert into t values (1) returning *) select * from x')).toMatch(/CTE/)
    expect(readOnlyViolation("select 'delete from t', 'set_config(' from x")).toBeUndefined()
    expect(readOnlyViolation('-- delete from t\nselect 1')).toBeUndefined()
    expect(readOnlyViolation('with x as (select 1) select * from x')).toBeUndefined()
  })

  it('rejects those statements before the transport sees them', async () => {
    const f = fake()
    const s = new DbSession({ ...cfg, readonly: true }, f.transport, dialects.sqlite)
    expect((await s.execute('with x as (delete from t returning id) select * from x')).error).toMatch(/read-only/i)
    expect((await s.execute("select set_config('a','b',false)")).error).toMatch(/read-only/i)
    expect(f.calls).toEqual([])
    expect((await s.execute('select 1')).error).toBeUndefined()
    expect(f.calls).toEqual(['select 1\nLIMIT 501 OFFSET 0'])
  })
})

describe('Submit row-count check', () => {
  it('fails and rolls back when an UPDATE affects no rows', async () => {
    const f = fake(0)
    const s = new DbSession(cfg, f.transport, dialects.sqlite)
    const r = await s.submit(['update t set v = 1 where id = 99'])
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/No rows were affected/i)
    expect(f.calls).toEqual(['BEGIN', 'update t set v = 1 where id = 99', 'ROLLBACK'])
  })

  it('fails and rolls back when a DELETE affects no rows', async () => {
    const f = fake(0)
    const s = new DbSession(cfg, f.transport, dialects.sqlite)
    const r = await s.submit(['delete from t where id = 99'])
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/No rows were affected/i)
    expect(f.calls.at(-1)).toBe('ROLLBACK')
  })

  it('commits when rows were affected', async () => {
    const f = fake(1)
    const s = new DbSession(cfg, f.transport, dialects.sqlite)
    const r = await s.submit(['update t set v = 1 where id = 1'])
    expect(r.ok).toBe(true)
    expect(f.calls.at(-1)).toBe('COMMIT')
  })
})
