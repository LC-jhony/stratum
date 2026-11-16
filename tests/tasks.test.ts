import { describe, expect, it } from 'vitest'
import { dueTasks, MAX_INTERVAL_MINUTES, nextRunFor, normalizeTaskInput, recordRun, sanitizeStoredTasks, taskExtension } from '../src/core/tasks'
import type { ScheduledTask, TaskInput } from '../src/shared/tasks'

const input: TaskInput = {
  name: 'Nightly orders',
  connectionId: 'c1',
  sql: 'select * from orders',
  format: 'csv',
  outputPath: '/exports/orders.csv',
  everyMinutes: 60,
  enabled: true,
}

const stored = (patch: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: 't1', name: 'Nightly orders', connectionId: 'c1', sql: 'select 1', format: 'csv',
  outputPath: '/exports/orders.csv', everyMinutes: 60, enabled: true, createdAt: 1, ...patch,
})

describe('normalizeTaskInput', () => {
  it('trims fields and fills a default name', () => {
    expect(normalizeTaskInput({ ...input, name: '  ', sql: '  select 1  ' }))
      .toMatchObject({ name: 'Scheduled export', sql: 'select 1', enabled: true })
  })

  it('rejects missing connection, SQL, output or interval', () => {
    expect(() => normalizeTaskInput({ ...input, connectionId: '' })).toThrow('data source')
    expect(() => normalizeTaskInput({ ...input, sql: '' })).toThrow('SQL statement')
    expect(() => normalizeTaskInput({ ...input, outputPath: '' })).toThrow('output file')
    expect(() => normalizeTaskInput({ ...input, everyMinutes: 0 })).toThrow('interval')
    expect(() => normalizeTaskInput({ ...input, everyMinutes: MAX_INTERVAL_MINUTES + 1 })).toThrow('interval')
  })

  it('rejects an unknown format and rounds the interval', () => {
    expect(() => normalizeTaskInput({ ...input, format: 'pdf' as never })).toThrow('format')
    expect(normalizeTaskInput({ ...input, everyMinutes: 59.6 }).everyMinutes).toBe(60)
  })

  it('maps each format to its file extension', () => {
    expect(['csv', 'tsv', 'json', 'insert', 'xlsx'].map((f) => taskExtension(f as never)))
      .toEqual(['csv', 'tsv', 'json', 'sql', 'xlsx'])
  })
})

describe('nextRunFor', () => {
  const now = 1_000_000

  it('plans the first run one interval ahead', () => {
    expect(nextRunFor(undefined, input, now)).toBe(now + 60 * 60_000)
  })

  it('keeps a future plan when only SQL or output changed', () => {
    const previous = stored({ nextRun: now + 10 * 60_000 })
    expect(nextRunFor(previous, input, now)).toBe(now + 10 * 60_000)
  })

  it('restarts the clock when the interval changed or the task was disabled', () => {
    const previous = stored({ nextRun: now + 10 * 60_000 })
    expect(nextRunFor(previous, { ...input, everyMinutes: 120 }, now)).toBe(now + 120 * 60_000)
    expect(nextRunFor(previous, { ...input, enabled: false }, now)).toBeUndefined()
  })

  it('plans a run when re-enabling after disabled', () => {
    expect(nextRunFor(stored({ enabled: false, nextRun: undefined }), input, now)).toBe(now + 60 * 60_000)
  })
})

describe('dueTasks', () => {
  const now = 10_000

  it('selects enabled tasks whose time arrived, oldest first', () => {
    const tasks = [
      stored({ id: 'b', nextRun: now }),
      stored({ id: 'a', nextRun: now - 5 }),
      stored({ id: 'future', nextRun: now + 1 }),
      stored({ id: 'off', enabled: false, nextRun: now - 10 }),
    ]
    expect(dueTasks(tasks, now).map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('treats a task without a plan as due', () => {
    expect(dueTasks([stored({ nextRun: undefined })], now)).toHaveLength(1)
  })
})

describe('recordRun', () => {
  it('keeps the failure visible and retries at the same interval', () => {
    const now = 5_000
    const next = recordRun(stored(), { at: now, ok: false, message: 'boom' }, now)
    expect(next.lastRun).toMatchObject({ ok: false, message: 'boom' })
    expect(next.nextRun).toBe(now + 60 * 60_000)
  })

  it('leaves no next run when the task is disabled', () => {
    expect(recordRun(stored({ enabled: false }), { at: 1, ok: true, message: 'ok' }, 1).nextRun).toBeUndefined()
  })
})

describe('sanitizeStoredTasks', () => {
  it('drops malformed entries and clamps names', () => {
    const out = sanitizeStoredTasks([
      stored(),
      { id: 'bad' },
      { ...stored(), format: 'exe' },
      { ...stored(), everyMinutes: 0 },
      'nope',
    ])
    expect(out.map((t) => t.id)).toEqual(['t1'])
  })

  it('returns an empty list for non-arrays', () => {
    expect(sanitizeStoredTasks(undefined)).toEqual([])
    expect(sanitizeStoredTasks({ tasks: [] })).toEqual([])
  })
})
