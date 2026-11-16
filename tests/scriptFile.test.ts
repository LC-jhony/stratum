import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/core/settings'

const fake = vi.hoisted(() => ({
  dialogs: { openText: vi.fn(async (): Promise<{ path: string; name: string; content: string } | null> => null) },
  script: {
    read: vi.fn(async (p: string, _from?: string) => ({ path: `/scripts/${p}`, name: p, content: 'select 1' })),
    write: vi.fn(async (_path: string | undefined, _content: string, _name?: string): Promise<string | null> => null),
  },
  db: {
    execute: vi.fn(async (_id: string, sql: string) => ({ sql, columns: [{ name: 'v' }], rows: [['ok']], durationMs: 1, offset: 0, hasMore: false })),
    transaction: vi.fn(async () => ({ open: false, autoCommit: true })),
    introspect: vi.fn(async () => ({})),
    plan: vi.fn(), cancel: vi.fn(), begin: vi.fn(), commit: vi.fn(), rollback: vi.fn(),
  },
  history: { add: vi.fn(async () => undefined) },
  settings: { set: vi.fn(async () => undefined) },
}))

vi.mock('../src/renderer/src/ipc/client', () => ({ ipc: fake }))

const { useWorkbench } = await import('../src/renderer/src/store/workbench')

const tab = (patch: Record<string, unknown> = {}) => ({
  id: 't1', type: 'console' as const, connectionId: 'c1', title: 'console', sql: '',
  results: [], activeResult: 0, running: false, ...patch,
})

const reset = () => {
  fake.dialogs.openText.mockReset()
  fake.dialogs.openText.mockResolvedValue(null)
  fake.script.read.mockReset()
  fake.script.read.mockImplementation(async (p: string, _from?: string) => ({ path: `/scripts/${p}`, name: p, content: 'select 1' }))
  fake.script.write.mockReset()
  fake.script.write.mockResolvedValue(null)
  fake.db.execute.mockClear()
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

beforeEach(() => {
  (globalThis as { window?: unknown }).window = { alert: vi.fn(), confirm: () => true }
  reset()
})

describe('SQL script files', () => {
  it('opens a file in a console bound to the active data source', async () => {
    fake.dialogs.openText.mockResolvedValueOnce({ path: '/work/report.sql', name: 'report.sql', content: 'select 42' })
    await useWorkbench.getState().openScript()
    const state = useWorkbench.getState()
    const opened = state.tabs[0]
    expect(opened).toMatchObject({ type: 'console', title: 'report.sql', path: '/work/report.sql', sql: 'select 42', connectionId: 'c1', dirty: false })
    expect(fake.dialogs.openText).toHaveBeenCalledTimes(1)
  })

  it('reuses an untouched console instead of leaving an empty tab behind', async () => {
    fake.dialogs.openText.mockResolvedValueOnce({ path: '/work/a.sql', name: 'a.sql', content: 'select 1' })
    await useWorkbench.getState().openScript()
    expect(useWorkbench.getState().tabs).toHaveLength(1)
    expect(useWorkbench.getState().tabs[0].id).toBe('t1')
  })

  it('opens a new tab when the current console already has text', async () => {
    useWorkbench.setState({ tabs: [tab({ sql: 'select 1' })] } as never)
    fake.dialogs.openText.mockResolvedValueOnce({ path: '/work/a.sql', name: 'a.sql', content: 'select 2' })
    await useWorkbench.getState().openScript()
    expect(useWorkbench.getState().tabs).toHaveLength(2)
    expect(useWorkbench.getState().tabs[1]).toMatchObject({ title: 'a.sql', path: '/work/a.sql' })
  })

  it('saves back to the known path and clears the dirty flag', async () => {
    useWorkbench.setState({ tabs: [tab({ path: '/work/q.sql', title: 'q.sql', sql: 'select 1', dirty: true })] } as never)
    fake.script.write.mockResolvedValueOnce('/work/q.sql')
    expect(await useWorkbench.getState().saveScript('t1')).toBe(true)
    expect(fake.script.write).toHaveBeenCalledWith('/work/q.sql', 'select 1', 'q.sql')
    expect(useWorkbench.getState().tabs[0]).toMatchObject({ path: '/work/q.sql', title: 'q.sql', dirty: false })
  })

  it('Save As always asks for a path, even when the tab has one', async () => {
    useWorkbench.setState({ tabs: [tab({ path: '/work/q.sql', title: 'q.sql', sql: 'select 1', dirty: true })] } as never)
    fake.script.write.mockResolvedValueOnce('/work/other.sql')
    expect(await useWorkbench.getState().saveScript('t1', true)).toBe(true)
    expect(fake.script.write).toHaveBeenCalledWith(undefined, 'select 1', 'q.sql')
    expect(useWorkbench.getState().tabs[0]).toMatchObject({ path: '/work/other.sql', title: 'other.sql', dirty: false })
  })

  it('keeps the tab untouched when the save dialog is cancelled', async () => {
    useWorkbench.setState({ tabs: [tab({ path: '/work/q.sql', title: 'q.sql', sql: 'select 1', dirty: true })] } as never)
    fake.script.write.mockResolvedValueOnce(null)
    expect(await useWorkbench.getState().saveScript('t1')).toBe(false)
    expect(useWorkbench.getState().tabs[0]).toMatchObject({ path: '/work/q.sql', title: 'q.sql', dirty: true })
  })

  it('resolves top-level @include next to the script file', async () => {
    useWorkbench.setState({ tabs: [tab({ path: '/work/main.sql', sql: '@include seed.sql' })] } as never)
    await useWorkbench.getState().run('t1', ['@include seed.sql'])
    expect(fake.script.read).toHaveBeenCalledWith('seed.sql', '/work/main.sql')
    expect(fake.db.execute).toHaveBeenCalledTimes(1)
  })
})
