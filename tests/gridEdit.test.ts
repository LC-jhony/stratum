import { describe, expect, it } from 'vitest'
import { gridChanges } from '../src/core/gridEdit'

const base = {
  target: 'public.customers',
  dialect: 'postgres' as const,
  columns: ['id', 'name', 'active'],
  primaryKey: ['id'],
  rows: [[1, 'ada', true], [2, 'bob', false]],
  inserted: [],
}

describe('gridChanges', () => {
  it('updates only the edited columns of a row', () => {
    expect(gridChanges({ ...base, edits: new Map([['1:1', 'robert']]), deleted: new Set() }))
      .toEqual([`UPDATE public.customers SET "name" = 'robert' WHERE "id" = 2`])
  })

  it('groups several edits in one row into a single UPDATE', () => {
    const edits = new Map<string, unknown>([['0:1', 'Ada'], ['0:2', false]])
    expect(gridChanges({ ...base, edits, deleted: new Set() }))
      .toEqual([`UPDATE public.customers SET "name" = 'Ada', "active" = FALSE WHERE "id" = 1`])
  })

  it('deletes loaded rows and ignores edits on deleted rows', () => {
    const edits = new Map<string, unknown>([['1:1', 'gone']])
    const sql = gridChanges({ ...base, edits, deleted: new Set([1]) })
    expect(sql).toEqual(['DELETE FROM public.customers WHERE "id" = 2'])
  })

  it('inserts new rows and lets empty values fall back to column defaults', () => {
    const sql = gridChanges({ ...base, edits: new Map(), deleted: new Set(), inserted: [[3, 'cy', null]] })
    expect(sql).toEqual([`INSERT INTO public.customers ("id", "name") VALUES (3, 'cy')`])
  })

  it('inserts DEFAULT VALUES when a new row is completely blank', () => {
    expect(gridChanges({ ...base, edits: new Map(), deleted: new Set(), inserted: [[null, '', undefined]] }))
      .toEqual(['INSERT INTO public.customers DEFAULT VALUES'])
  })

  it('uses IS NULL for a null primary key and quotes per dialect', () => {
    const rows = [[null, 'x', true]]
    const sql = gridChanges({ ...base, rows, edits: new Map([['0:1', 'y']]), deleted: new Set() })
    expect(sql).toEqual([`UPDATE public.customers SET "name" = 'y' WHERE "id" IS NULL`])
  })

  it('returns nothing when there is nothing pending', () => {
    expect(gridChanges({ ...base, edits: new Map(), deleted: new Set() })).toEqual([])
  })
})
