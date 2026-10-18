import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { HistoryService } from '../src/main/services/historyService'
import { JsonStore } from '../src/main/services/store'

let dir: string
let history: HistoryService

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'stratum-history-'))
  history = new HistoryService(new JsonStore(path.join(dir, 'history.json'), { queries: {} }))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('HistoryService', () => {
  it('keeps newest-first, deduplicated statements per connection', async () => {
    await history.add('c1', ['select 1', 'select 2'])
    await history.add('c1', ['select 2', 'select 3'])
    expect(await history.get()).toEqual({ c1: ['select 2', 'select 3', 'select 1'] })
  })

  it('caps each connection at 100 statements', async () => {
    await history.add('c1', Array.from({ length: 120 }, (_, i) => `select ${i}`))
    expect((await history.get()).c1).toHaveLength(100)
  })

  it('merges legacy settings history without replacing current entries', async () => {
    await history.add('c1', ['new'])
    expect(await history.importLegacy({ c1: ['old'], c2: ['select 2'], bad: [1] })).toBe(true)
    expect(await history.get()).toEqual({ c1: ['old', 'new'], c2: ['select 2'] })
  })

  it('ignores malformed legacy data', async () => {
    expect(await history.importLegacy(undefined)).toBe(false)
    expect(await history.importLegacy([])).toBe(false)
    expect(await history.importLegacy({ c1: 'nope' })).toBe(false)
  })
})
