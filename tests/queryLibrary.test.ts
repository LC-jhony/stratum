import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SavedQuery } from '../src/shared/types'
import { QueryLibraryService } from '../src/main/services/queryLibraryService'
import { JsonStore } from '../src/main/services/store'

let dir: string
let library: QueryLibraryService

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'stratum-library-'))
  library = new QueryLibraryService(new JsonStore(path.join(dir, 'library.json'), { queries: [] }))
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const query = (over: Partial<SavedQuery> = {}): SavedQuery => ({
  id: 'q1',
  name: 'Top customers',
  sql: 'select * from customers order by total desc limit 10',
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

describe('QueryLibraryService', () => {
  it('stores a query and lists it', async () => {
    await library.save(query())
    const [saved] = await library.list()
    expect(saved).toMatchObject({ id: 'q1', name: 'Top customers' })
    expect(saved.updatedAt).toBeGreaterThan(1)
  })

  it('trims the name and rejects empty names or SQL', async () => {
    await library.save(query({ name: '  Names by country  ' }))
    expect((await library.list())[0].name).toBe('Names by country')
    await expect(library.save(query({ id: 'q2', name: '   ' }))).rejects.toThrow(/needs a name/i)
    await expect(library.save(query({ id: 'q3', sql: '  ' }))).rejects.toThrow(/empty/i)
  })

  it('updates by id, keeps createdAt and stamps a newer updatedAt', async () => {
    await library.save(query())
    const first = (await library.list())[0]
    await new Promise((r) => setTimeout(r, 5))
    await library.save({ ...first, name: 'Renamed', updatedAt: 0 })
    const [again] = await library.list()
    expect(again).toMatchObject({ id: 'q1', name: 'Renamed', createdAt: first.createdAt })
    expect(again.updatedAt).toBeGreaterThan(first.updatedAt)
  })

  it('lists the most recently edited query first', async () => {
    await library.save(query({ id: 'old', name: 'Old', createdAt: 1 }))
    await new Promise((r) => setTimeout(r, 5))
    await library.save(query({ id: 'new', name: 'New', createdAt: 1 }))
    expect((await library.list()).map((q) => q.id)).toEqual(['new', 'old'])
  })

  it('removes a query and is a no-op for unknown ids', async () => {
    await library.save(query())
    await library.remove('q1')
    expect(await library.list()).toEqual([])
    await expect(library.remove('missing')).resolves.toBeUndefined()
  })
})
