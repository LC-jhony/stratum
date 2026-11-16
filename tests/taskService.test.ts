import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  rows: [[1, 'ada'], [2, 'bob']] as unknown[][],
  error: undefined as string | undefined,
}))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => s,
    decryptString: (s: string) => s,
  },
}))

const { TaskService } = await import('../src/main/services/taskService')

let dir = ''
let service: InstanceType<typeof TaskService>

const session = {
  dialect: { id: 'postgres' },
  execute: async () => ({
    sql: 'select 1', durationMs: 1, hasMore: false, offset: 0,
    columns: [{ name: 'id', dataType: 'int' }, { name: 'name', dataType: 'text' }],
    rows: state.rows, error: state.error,
  }),
}
const manager = {
  open: async () => ({ version: 'test' }),
  require: () => session,
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'stratum-tasks-'))
  state.rows = [[1, 'ada'], [2, 'bob']]
  state.error = undefined
  service = new TaskService(path.join(dir, 'tasks.json'), manager as never, { tickMs: 3_600_000 })
})

afterEach(async () => {
  service.stop()
  await rm(dir, { recursive: true, force: true })
})

const input = (patch: Record<string, unknown> = {}) => ({
  name: 'Orders', connectionId: 'c1', sql: 'select * from orders', format: 'csv' as const,
  outputPath: path.join(dir, 'orders.csv'), everyMinutes: 60, enabled: true, ...patch,
})

describe('TaskService', () => {
  it('saves a task with a planned next run and lists it', async () => {
    const before = Date.now()
    const tasks = await service.save(input())
    expect(tasks).toHaveLength(1)
    expect(tasks[0].nextRun).toBeGreaterThanOrEqual(before + 59 * 60_000)
    expect(await service.list()).toHaveLength(1)
  })

  it('runs an export now and writes the selected format', async () => {
    const tasks = await service.save(input())
    const after = await service.runNow(tasks[0].id)
    expect(after[0].lastRun).toMatchObject({ ok: true, rows: 2 })
    expect((await readFile(path.join(dir, 'orders.csv'), 'utf8')).replace(/^\uFEFF/, '')).toBe('id,name\n1,ada\n2,bob')
  })

  it('writes JSON and keeps the previous export when the query fails', async () => {
    const tasks = await service.save(input({ format: 'json', outputPath: path.join(dir, 'orders.json') }))
    await service.runNow(tasks[0].id)
    const json = JSON.parse(await readFile(path.join(dir, 'orders.json'), 'utf8'))
    expect(json).toEqual([{ id: 1, name: 'ada' }, { id: 2, name: 'bob' }])

    state.error = 'relation "orders" does not exist'
    const failed = await service.runNow(tasks[0].id)
    expect(failed[0].lastRun).toMatchObject({ ok: false, message: 'relation "orders" does not exist' })
    expect(JSON.parse(await readFile(path.join(dir, 'orders.json'), 'utf8'))).toHaveLength(2)
  })

  it('removes a task without deleting its output file', async () => {
    const tasks = await service.save(input())
    const output = tasks[0].outputPath
    await service.runNow(tasks[0].id)
    expect(await service.remove(tasks[0].id)).toEqual([])
    expect(await readFile(output, 'utf8')).toContain('ada')
  })

  it('rejects an invalid task and keeps the stored list intact', async () => {
    await service.save(input())
    await expect(service.save(input({ everyMinutes: 0 }))).rejects.toThrow('interval')
    expect(await service.list()).toHaveLength(1)
  })
})
