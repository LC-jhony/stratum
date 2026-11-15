import { describe, expect, it } from 'vitest'
import { searchObjects } from '../src/core/objectSearch'

const connections = [
  {
    id: 'c1', name: 'analytics',
    model: { schemas: [{ name: 'public', tables: [
      { name: 'orders', kind: 'table' as const, columns: [{ name: 'id' }, { name: 'status' }, { name: 'customer_id' }] },
      { name: 'customers', kind: 'table' as const, columns: [{ name: 'id' }, { name: 'email' }] },
    ] }] },
  },
  {
    id: 'c2', name: 'billing',
    model: { schemas: [{ name: 'sales', tables: [
      { name: 'invoices', kind: 'table' as const, columns: [{ name: 'id' }, { name: 'order_id' }] },
    ] }] },
  },
]

describe('global object search', () => {
  it('finds tables across every loaded connection', () => {
    const hits = searchObjects(connections, 'orders')
    expect(hits.map((h) => `${h.connectionName}:${h.table}:${h.match}`)).toContain('analytics:orders:table')
    expect(hits.some((h) => h.table === 'invoices')).toBe(false)
  })

  it('searches columns and reports their table', () => {
    const hits = searchObjects(connections, 'email')
    expect(hits[0]).toMatchObject({ connectionName: 'analytics', table: 'customers', column: 'email', match: 'column' })
  })

  it('scopes dotted queries to schema.table and table.column', () => {
    expect(searchObjects(connections, 'sales.inv').map((h) => h.table)).toContain('invoices')
    expect(searchObjects(connections, 'orders.stat')[0]).toMatchObject({ table: 'orders', column: 'status' })
    expect(searchObjects(connections, 'public.orders').map((h) => h.table)).toContain('orders')
  })

  it('returns nothing for an empty query and caps the result set', () => {
    expect(searchObjects(connections, '   ')).toEqual([])
    expect(searchObjects(connections, 'o', 3).length).toBeLessThanOrEqual(3)
  })
})
