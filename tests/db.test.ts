import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dialects } from '../src/main/db/dialects'
import { DbSession } from '../src/main/db/session'
import { SqliteTransport } from '../src/main/db/transports/sqlite'
import type { Run } from '../src/main/db/types'
import type { ConnectionConfig } from '../src/shared/types'
import { buildErdGraph, layoutErd, renderErdSvg, cssPalette } from '../src/renderer/src/erd/erd'

const dir = mkdtempSync(path.join(tmpdir(), 'stratum-'))
const cfg: ConnectionConfig = { id: 't', name: 't', kind: 'sqlite', filePath: path.join(dir, 'shop.db') }
let s: DbSession
beforeAll(async () => {
  s = new DbSession(cfg, new SqliteTransport(cfg), dialects.sqlite)
  await s.open()
  for (const q of [
    'create table customers (id integer primary key, name text not null, email text unique)',
    'create table products (id integer primary key, title text not null, price real)',
    'create table orders (id integer primary key, customer_id integer not null references customers(id), placed_at text)',
    'create table order_items (order_id integer references orders(id), product_id integer references products(id), qty integer, primary key (order_id, product_id))',
    'create table employees (id integer primary key, manager_id integer references employees(id))',
    'create view big_orders as select * from orders',
  ]) { const r = await s.execute(q); expect(r.error).toBeUndefined() }
  await s.execute(`insert into customers (name, email) values ${Array.from({ length: 1200 }, (_, i) => `('c${i}','c${i}@x.io')`).join(',')}`)
})
afterAll(() => { void s.close(); rmSync(dir, { recursive: true, force: true }) })

describe('session', () => {
  it('pages results and reports hasMore', async () => {
    const a = await s.execute('select * from customers', { limit: 500 })
    expect(a.rows).toHaveLength(500); expect(a.hasMore).toBe(true)
    const c = await s.execute('select * from customers', { limit: 500, offset: 1000 })
    expect(c.rows).toHaveLength(200); expect(c.hasMore).toBe(false)
  })
  it('returns errors as results, not exceptions', async () => expect((await s.execute('select * from nope')).error).toMatch(/no such table/i))
  it('keeps an existing LIMIT intact', async () => expect((await s.execute('select * from customers limit 3')).rows).toHaveLength(3))
  it('submit is atomic: a failing statement rolls everything back', async () => {
    const r = await s.submit([`update customers set name='changed' where id=1`, `insert into customers (id, name) values (1, 'dup')`])
    expect(r.ok).toBe(false)
    expect((await s.execute('select name from customers where id=1')).rows[0][0]).toBe('c0')
  })
  it('submit commits on success', async () => {
    expect((await s.submit([`update customers set name='ok' where id=2`])).ok).toBe(true)
    expect((await s.execute('select name from customers where id=2')).rows[0][0]).toBe('ok')
  })
  it('read-only sources reject writes', async () => {
    const ro = new DbSession({ ...cfg, readonly: true }, new SqliteTransport({ ...cfg, readonly: true }), dialects.sqlite)
    await ro.open()
    expect((await ro.execute('delete from customers')).error).toMatch(/read-only/i)
    await ro.close()
  })
})
describe('introspection', () => {
  it('discovers tables, views, PKs, composite PKs, FKs and indexes', async () => {
    const m = await s.introspect()
    const t = (n: string) => m.schemas[0].tables.find((x) => x.name === n)!
    expect(t('big_orders').kind).toBe('view')
    expect(t('customers').columns.find((c) => c.name === 'id')!.isPrimaryKey).toBe(true)
    expect(t('order_items').columns.filter((c) => c.isPrimaryKey).map((c) => c.name).sort()).toEqual(['order_id', 'product_id'])
    expect(t('orders').foreignKeys[0]).toMatchObject({ columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] })
    expect(t('customers').indexes.some((i) => i.unique && i.columns[0] === 'email')).toBe(true)
  })
})
describe('ERD', () => {
  it('builds, lays out without overlap and renders themed SVG', async () => {
    const m = await s.introspect()
    const g = buildErdGraph(m)
    expect(g.nodes.map((n) => n.name)).not.toContain('big_orders')
    expect(g.edges).toHaveLength(4)
    const l = await layoutErd(g)
    for (const a of l.nodes) for (const b of l.nodes) if (a !== b) {
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
      expect(overlap, `${a.name}/${b.name}`).toBe(false)
    }
    const orders = l.nodes.find((n) => n.name === 'orders')!, cust = l.nodes.find((n) => n.name === 'customers')!
    const e = l.edges.find((x) => x.from === orders.id && x.to === cust.id)!
    expect(e.start.y).toBeGreaterThan(orders.y + 34); expect(e.start.y).toBeLessThan(orders.y + orders.height) // leaves from a column row
    expect(e.d).toMatch(/^M/)
    const svg = renderErdSvg(l, cssPalette())
    expect(svg).toContain('var(--vscode-editor-foreground)')
    expect(svg.match(/class="node"/g)).toHaveLength(5)
  })
  it('focus mode keeps only FK neighbours', async () => {
    const g = buildErdGraph(await s.introspect(), { focus: { table: 'orders', depth: 1 } })
    expect(g.nodes.map((n) => n.name).sort()).toEqual(['customers', 'order_items', 'orders'])
  })
})

describe('engine-specific introspection', () => {
  const raw = (columns: string[], rows: unknown[][]) => ({ columns: columns.map((name) => ({ name })), rows })
  /** Fake Run that answers canned rows per catalog query (first matching key). */
  const fakeRun = (canned: [string, string[], unknown[][]][]) => {
    const seen: string[] = []
    const run: Run = async (sql) => {
      seen.push(sql)
      const hit = canned.find(([key]) => sql.includes(key))
      if (!hit) throw new Error(`unexpected catalog query: ${sql}`)
      return raw(hit[1], hit[2])
    }
    return { run, seen }
  }

  it('oracle: ALL_* dictionary views (tables, views, columns, PK, FK, indexes)', async () => {
    const { run } = fakeRun([
      ['from all_tables ', ['schema', 'name', 'kind'], [['SHOP', 'ORDERS', 'TABLE']]],
      ['from all_views ', ['schema', 'name', 'kind'], [['SHOP', 'ORDER_TOTALS', 'VIEW']]],
      ['from all_tab_cols', ['schema', 'tbl', 'col', 'type', 'nullable', 'dflt', 'pos'], [
        ['SHOP', 'ORDERS', 'ID', 'NUMBER(10)', 'N', '', 1],
        ['SHOP', 'ORDERS', 'CUSTOMER_ID', 'NUMBER(10)', 'N', '', 2],
        ['SHOP', 'ORDERS', 'STATUS', 'VARCHAR2(20)', 'Y', "'new'", 3],
      ]],
      ["constraint_type = 'P'", ['schema', 'tbl', 'col'], [['SHOP', 'ORDERS', 'ID']]],
      ["constraint_type = 'R'", ['schema', 'tbl', 'name', 'cols', 'ref_schema', 'ref_table', 'ref_cols'], [['SHOP', 'ORDERS', 'FK_ORDERS_CUSTOMER', 'CUSTOMER_ID', 'SHOP', 'CUSTOMERS', 'ID']]],
      ['from all_indexes', ['schema', 'tbl', 'name', 'uniq', 'cols'], [['SHOP', 'ORDERS', 'IX_STATUS', 0, 'STATUS']]],
    ])
    const m = await dialects.oracle.introspect(run)
    const shop = m.schemas[0]
    expect(shop.name).toBe('SHOP')
    expect(shop.tables.map((t) => t.name).sort()).toEqual(['ORDERS', 'ORDER_TOTALS'])
    expect(shop.tables.find((t) => t.name === 'ORDER_TOTALS')!.kind).toBe('view')
    const orders = shop.tables.find((t) => t.name === 'ORDERS')!
    expect(orders.columns[2]).toMatchObject({ name: 'STATUS', dataType: 'VARCHAR2(20)', nullable: true, default: "'new'", ordinal: 3, isPrimaryKey: false })
    expect(orders.columns[0].isPrimaryKey).toBe(true)
    expect(orders.foreignKeys[0]).toMatchObject({ name: 'FK_ORDERS_CUSTOMER', columns: ['CUSTOMER_ID'], refTable: 'CUSTOMERS', refColumns: ['ID'] })
    expect(orders.indexes[0]).toMatchObject({ name: 'IX_STATUS', unique: false, columns: ['STATUS'] })
  })

  it('clickhouse: system.tables/system.columns with PK derived from is_in_primary_key', async () => {
    const { run } = fakeRun([
      ['from system.tables', ['schema', 'name', 'kind'], [['shop', 'orders', 'TABLE'], ['shop', 'recent_orders', 'VIEW']]],
      ['from system.columns', ['schema', 'tbl', 'col', 'type', 'nullable', 'dflt', 'pos', 'pk'], [
        ['shop', 'orders', 'id', 'UInt64', 'NO', '', 1, 1],
        ['shop', 'orders', 'status', 'Nullable(String)', 'YES', "'new'", 2, 0],
      ]],
    ])
    const m = await dialects.clickhouse.introspect(run)
    const orders = m.schemas[0].tables.find((t) => t.name === 'orders')!
    expect(orders.columns[0]).toMatchObject({ name: 'id', dataType: 'UInt64', nullable: false, ordinal: 1, isPrimaryKey: true })
    expect(orders.columns[1]).toMatchObject({ name: 'status', dataType: 'Nullable(String)', nullable: true, default: "'new'", isPrimaryKey: false })
    expect(m.schemas[0].tables.find((t) => t.name === 'recent_orders')!.kind).toBe('view')
  })

  it('cassandra: system_schema catalogs (no ORDER BY, PK from column kind)', async () => {
    const { run, seen } = fakeRun([
      ['from system_schema.tables', ['schema', 'name', 'kind'], [['shop', 'orders', 'TABLE']]],
      ['from system_schema.views', ['schema', 'name', 'kind'], []],
      ['from system_schema.columns', ['schema', 'tbl', 'col', 'type', 'kind', 'nullable', 'dflt', 'pos'], [
        ['shop', 'orders', 'id', 'uuid', 'partition_key', 'NO', null, 0],
        ['shop', 'orders', 'placed_at', 'timestamp', 'clustering', 'NO', null, 0],
        ['shop', 'orders', 'status', 'text', 'regular', 'YES', null, null],
      ]],
    ])
    const m = await dialects.cassandra.introspect(run)
    const orders = m.schemas[0].tables[0]
    expect(orders.columns.filter((c) => c.isPrimaryKey).map((c) => c.name)).toEqual(['id', 'placed_at'])
    expect(orders.columns[2]).toMatchObject({ name: 'status', dataType: 'text', nullable: true, default: null, isPrimaryKey: false })
    expect(seen.every((s) => !/\border\s+by\b/i.test(s))).toBe(true)
  })

  it('sybase: sysobjects/syscolumns with bit-8 nullability and syskeys PKs', async () => {
    const { run } = fakeRun([
      ['from sysobjects o join syscolumns c', ['schema', 'tbl', 'col', 'type', 'nullable', 'dflt', 'pos'], [
        ['dbo', 'orders', 'id', 'int', 'NO', null, 1],
        ['dbo', 'orders', 'status', 'varchar', 'YES', "'new'", 2],
      ]],
      ['from sysobjects o where', ['schema', 'name', 'kind'], [['dbo', 'orders', 'TABLE']]],
      ['from syskeys k', ['schema', 'tbl', 'col'], [['dbo', 'orders', 'id']]],
    ])
    const m = await dialects.sybase.introspect(run)
    const orders = m.schemas[0].tables[0]
    expect(orders.columns[0]).toMatchObject({ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true })
    expect(orders.columns[1]).toMatchObject({ name: 'status', nullable: true, default: "'new'" })
  })

  it('db2: SYSCAT catalogs for tables, columns, PK, FK and indexes', async () => {
    const { run } = fakeRun([
      ['from syscat.tables where', ['schema', 'name', 'kind'], [['SHOP', 'ORDERS', 'TABLE'], ['SHOP', 'ORDER_TOTALS', 'VIEW']]],
      ['from syscat.columns c', ['schema', 'tbl', 'col', 'type', 'nullable', 'dflt', 'pos'], [
        ['SHOP', 'ORDERS', 'ID', 'INTEGER', 'N', '', 1],
        ['SHOP', 'ORDERS', 'STATUS', 'VARCHAR(20)', 'Y', "'new'", 2],
      ]],
      ['join syscat.indexcoluse', ['schema', 'tbl', 'col'], [['SHOP', 'ORDERS', 'ID']]],
      ['from syscat.references r', ['schema', 'tbl', 'name', 'cols', 'ref_schema', 'ref_table', 'ref_cols'], [['SHOP', 'ORDERS', 'FK_1', 'CUSTOMER_ID', 'SHOP', 'CUSTOMERS', 'ID']]],
      ["uniquerule in ('U','D')", ['schema', 'tbl', 'name', 'uniq', 'cols'], [['SHOP', 'ORDERS', 'IX_STATUS', 1, 'STATUS']]],
    ])
    const m = await dialects.db2.introspect(run)
    const shop = m.schemas[0]
    expect(shop.tables.find((t) => t.name === 'ORDER_TOTALS')!.kind).toBe('view')
    const orders = shop.tables.find((t) => t.name === 'ORDERS')!
    expect(orders.columns[1]).toMatchObject({ name: 'STATUS', dataType: 'VARCHAR(20)', nullable: true, default: "'new'" })
    expect(orders.columns[0].isPrimaryKey).toBe(true)
    expect(orders.foreignKeys[0]).toMatchObject({ name: 'FK_1', columns: ['CUSTOMER_ID'], refTable: 'CUSTOMERS', refColumns: ['ID'] })
    expect(orders.indexes[0]).toMatchObject({ name: 'IX_STATUS', unique: true, columns: ['STATUS'] })
  })

  it('bigquery: probes region-scoped INFORMATION_SCHEMA until one answers', async () => {
    const calls: string[] = []
    const run: Run = async (sql) => {
      calls.push(sql)
      if (sql.includes('region-us')) throw new Error('Not found: region-us')
      if (sql.includes('TABLE_CONSTRAINTS')) return raw(['schema', 'tbl', 'col'], [['shop', 'orders', 'id']])
      if (sql.includes('COLUMNS')) return raw(['schema', 'tbl', 'col', 'type', 'nullable', 'dflt', 'pos'], [['shop', 'orders', 'id', 'INT64', 'NO', null, 1]])
      if (sql.includes('TABLES')) return raw(['schema', 'name', 'kind'], [['shop', 'orders', 'BASE TABLE']])
      throw new Error(`unexpected: ${sql}`)
    }
    const m = await dialects.bigquery.introspect(run)
    expect(m.schemas[0].tables[0]).toMatchObject({ name: 'orders', kind: 'table' })
    expect(m.schemas[0].tables[0].columns[0]).toMatchObject({ name: 'id', dataType: 'INT64', isPrimaryKey: true })
    expect(calls.some((c) => c.includes('region-us'))).toBe(true)
    expect(calls.some((c) => c.includes('region-eu'))).toBe(true)
    expect(calls.every((c) => !c.includes('region-asia-east1'))).toBe(true)
  })
})
