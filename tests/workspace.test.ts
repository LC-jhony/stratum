import { describe, expect, it } from 'vitest'
import {
  parseWorkspace,
  serializeWorkspace,
  WORKSPACE_MAX_TABS,
  WORKSPACE_MAX_TAB_SQL,
  WORKSPACE_VERSION,
} from '../src/core/workspace'

const tab = (id: string, connectionId = 'c1', sql = 'select 1') => ({ id, title: `Console ${id}`, connectionId, sql })

describe('serializeWorkspace', () => {
  it('returns undefined when there is nothing worth restoring', () => {
    expect(serializeWorkspace([])).toBeUndefined()
    expect(serializeWorkspace([{ id: 'a', title: 'x', connectionId: 'c1', sql: '   \n' }])).toBeUndefined()
  })

  it('keeps console text and a still-open active tab', () => {
    const raw = serializeWorkspace([tab('a'), tab('b', 'c1', 'select 2')], 'b')
    expect(raw).toBeDefined()
    const snapshot = JSON.parse(raw!)
    expect(snapshot.version).toBe(WORKSPACE_VERSION)
    expect(snapshot.activeTab).toBe('b')
    expect(snapshot.tabs).toEqual([
      { id: 'a', title: 'Console a', connectionId: 'c1', sql: 'select 1' },
      { id: 'b', title: 'Console b', connectionId: 'c1', sql: 'select 2' },
    ])
  })

  it('drops an active tab that is not part of the snapshot', () => {
    expect(JSON.parse(serializeWorkspace([tab('a')], 'missing')!).activeTab).toBeUndefined()
  })

  it('caps the number of tabs', () => {
    const many = Array.from({ length: WORKSPACE_MAX_TABS + 5 }, (_, i) => tab(`${i}`))
    expect(JSON.parse(serializeWorkspace(many)!).tabs).toHaveLength(WORKSPACE_MAX_TABS)
  })

  it('truncates oversized console text', () => {
    const raw = serializeWorkspace([tab('a', 'c1', 'x'.repeat(WORKSPACE_MAX_TAB_SQL + 100))])
    expect(JSON.parse(raw!).tabs[0].sql).toHaveLength(WORKSPACE_MAX_TAB_SQL)
  })
})

describe('parseWorkspace', () => {
  const raw = serializeWorkspace([tab('a'), tab('b', 'c2', 'select 2')], 'a')!
  const connections = ['c1', 'c2']

  it('round-trips what serializeWorkspace wrote', () => {
    const snapshot = parseWorkspace(raw, connections)
    expect(snapshot?.tabs.map((t) => t.id)).toEqual(['a', 'b'])
    expect(snapshot?.activeTab).toBe('a')
  })

  it('rejects malformed or unknown payloads', () => {
    expect(parseWorkspace(undefined, connections)).toBeUndefined()
    expect(parseWorkspace('', connections)).toBeUndefined()
    expect(parseWorkspace('{oops', connections)).toBeUndefined()
    expect(parseWorkspace('[]', connections)).toBeUndefined()
    expect(parseWorkspace('{"version":2,"tabs":[]}', connections)).toBeUndefined()
    expect(parseWorkspace('{"version":1,"tabs":"nope"}', connections)).toBeUndefined()
  })

  it('drops tabs whose connection no longer exists', () => {
    const snapshot = parseWorkspace(raw, ['c2'])
    expect(snapshot?.tabs.map((t) => t.id)).toEqual(['b'])
    expect(snapshot?.activeTab).toBeUndefined()
  })

  it('skips malformed entries instead of failing the whole snapshot', () => {
    const payload = JSON.stringify({
      version: 1,
      tabs: [
        null,
        { id: 'a', connectionId: 'c1', sql: 'select 1' },
        { id: '', connectionId: 'c1', sql: 'select 2' },
        { id: 'b', connectionId: 'gone', sql: 'select 3' },
        { id: 'c', connectionId: 'c1', sql: '  ' },
      ],
    })
    expect(parseWorkspace(payload, connections)?.tabs).toEqual([
      { id: 'a', title: 'SQL console', connectionId: 'c1', sql: 'select 1' },
    ])
  })

  it('applies the same caps to hand-edited storage', () => {
    const payload = JSON.stringify({
      version: 1,
      tabs: Array.from({ length: WORKSPACE_MAX_TABS + 3 }, (_, i) => ({ id: `t${i}`, connectionId: 'c1', sql: 'select 1' })),
    })
    expect(parseWorkspace(payload, ['c1'])?.tabs).toHaveLength(WORKSPACE_MAX_TABS)
  })
})
