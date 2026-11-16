import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/core/settings'
import type { QueryResult } from '../src/shared/types'

const fake = vi.hoisted(() => ({
  db: {
    execute: vi.fn(async (_id: string, sql: string): Promise<QueryResult> => ({
      sql, columns: [{ name: 'v' }], rows: [['ok']], durationMs: 1, offset: 0, hasMore: false,
    })),
    transaction: vi.fn(async () => ({ open: false, autoCommit: true })),
    introspect: vi.fn(async () => ({})),
    plan: vi.fn(), cancel: vi.fn(), begin: vi.fn(), commit: vi.fn(), rollback: vi.fn(),
  },
  script: { read: vi.fn(async (p: string, _from?: string) => ({ path: `/scripts/${p}`, name: p, content: 'select 1' })) },
  export: {
    save: vi.fn(async (_name: string, _content: string, _filters?: unknown) => '/tmp/report.csv'),
    saveBinary: vi.fn(async (_name: string, _content: string, _filters?: unknown) => '/tmp/report.xlsx'),
  },
  history: { add: vi.fn(async () => undefined) },
  settings: { set: vi.fn(async () => undefined) },
}))

vi.mock('../src/renderer/src/ipc/client', () => ({ ipc: fake }))

const { useWorkbench } = await import('../src/renderer/src/store/workbench')

const tab = () => ({
  id: 't1', type: 'console' as const, connectionId: 'c1', title: 'console', sql: '', results: [], activeResult: 0, running: false,
})

const reset = () => {
  fake.db.execute.mockClear()
  fake.db.transaction.mockClear()
  fake.script.read.mockReset()
  fake.script.read.mockImplementation(async (p: string, _from?: string) => ({ path: `/scripts/${p}`, name: p, content: 'select 1' }))
  fake.export.save.mockClear()
  fake.history.add.mockClear()
  useWorkbench.setState({
    tabs: [tab()], activeTab: 't1',
    connections: [{ id: 'c1', name: 'local', kind: 'sqlite' } as never],
    live: { c1: { status: 'ready' } },
    prefs: DEFAULT_SETTINGS,
    transactions: {},
    connect: async () => undefined,
  } as never)
}

const results = () => {
  const t = useWorkbench.getState().tabs[0]
  return t.type === 'console' ? t.results : []
}

beforeEach(reset)

describe('script execution', () => {
  it('applies @set variables to the following statements', async () => {
    await useWorkbench.getState().run('t1', ["@set who = alice\nselect '${who}'"])
    expect(fake.db.execute).toHaveBeenCalledTimes(1)
    expect(fake.db.execute.mock.calls[0][1]).toBe("select 'alice'")
    expect(results()).toHaveLength(1)
    // History stores what the user wrote, not the expanded SQL.
    expect(fake.history.add).toHaveBeenCalledWith('c1', ["@set who = alice\nselect '${who}'"])
  })

  it('includes a file and lets its @set affect later statements', async () => {
    fake.script.read.mockResolvedValueOnce({ path: '/scripts/seed.sql', name: 'seed.sql', content: '@set n = 2\nselect ${n}' })
    await useWorkbench.getState().run('t1', ['@include seed.sql', 'select ${n}'])
    expect(fake.script.read).toHaveBeenCalledWith('seed.sql', undefined)
    expect(fake.db.execute.mock.calls.map((c) => c[1])).toEqual(['select 2', 'select 2'])
    expect(results().map((r) => r.result.error)).toEqual([undefined, undefined])
  })

  it('resolves nested includes next to the including file', async () => {
    fake.script.read
      .mockResolvedValueOnce({ path: '/scripts/a/main.sql', name: 'main.sql', content: '@include nested.sql' })
      .mockResolvedValueOnce({ path: '/scripts/a/nested.sql', name: 'nested.sql', content: 'select 3' })
    await useWorkbench.getState().run('t1', ['@include a/main.sql'])
    expect(fake.script.read.mock.calls[1][0]).toBe('nested.sql')
    expect(fake.script.read.mock.calls[1][1]).toBe('/scripts/a/main.sql')
    expect(fake.db.execute.mock.calls.map((c) => c[1])).toEqual(['select 3'])
  })

  it('stops on a circular include', async () => {
    fake.script.read.mockResolvedValue({ path: '/scripts/same.sql', name: 'same.sql', content: '@include same.sql' })
    await useWorkbench.getState().run('t1', ['@include same.sql'])
    expect(results().at(-1)?.result.error).toContain('Circular @include')
    expect(fake.db.execute).not.toHaveBeenCalled()
  })

  it('reports a missing include without running more statements', async () => {
    fake.script.read.mockRejectedValueOnce(new Error('Cannot include "/nope.sql": the file does not exist.'))
    await useWorkbench.getState().run('t1', ['@include nope.sql', 'select 1'])
    expect(results()[0].result.error).toContain('does not exist')
    expect(fake.db.execute).not.toHaveBeenCalled()
  })

  it('exports the previous result through the save channel', async () => {
    await useWorkbench.getState().run('t1', ["select 'ok' as v\n@export report.csv"])
    expect(fake.export.save).toHaveBeenCalledTimes(1)
    expect(fake.export.save.mock.calls[0][0]).toBe('report.csv')
    expect(fake.export.save.mock.calls[0][1]).toContain('v')
    expect(fake.export.save.mock.calls[0][1]).toContain('ok')
    expect(results().at(-1)?.result.rows).toEqual([['/tmp/report.csv', 1]])
  })

  it('exports the last grid result when @export runs alone', async () => {
    useWorkbench.setState({
      tabs: [{
        ...tab(),
        results: [{
          id: 'r1', title: 'select',
          result: { sql: 'select 9', columns: [{ name: 'n' }], rows: [[9]], durationMs: 1, offset: 0, hasMore: false },
        }],
      }],
    } as never)
    await useWorkbench.getState().run('t1', ['@export out.json'])
    expect(fake.export.save.mock.calls[0][0]).toBe('out.json')
    expect(fake.export.save.mock.calls[0][1]).toContain('"n": 9')
  })

  it('reports @export without any result at all', async () => {
    await useWorkbench.getState().run('t1', ['@export out.csv'])
    expect(results()[0].result.error).toContain('There is no query result to export')
    expect(fake.export.save).not.toHaveBeenCalled()
  })

  it('reports a malformed command and stops before executing SQL', async () => {
    await useWorkbench.getState().run('t1', ['@set broken\nselect 1'])
    expect(results()[0].result.error).toContain('Line 1')
    expect(fake.db.execute).not.toHaveBeenCalled()
  })

  it('stops at a SQL error but keeps the completed results', async () => {
    fake.db.execute.mockResolvedValueOnce({ sql: 'select 1', columns: [], rows: [], durationMs: 1, offset: 0, hasMore: false, error: 'boom' })
    await useWorkbench.getState().run('t1', ['select 1', 'select 2'])
    expect(fake.db.execute).toHaveBeenCalledTimes(1)
    expect(results()[0].result.error).toBe('boom')
    const t = useWorkbench.getState().tabs[0]
    expect(t.type === 'console' && t.running).toBe(false)
  })
})
