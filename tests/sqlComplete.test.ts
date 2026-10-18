import { describe, expect, it } from 'vitest'
import { aliasFor, completeAt, type CompletionPrefs, type CompletionTable } from '../src/core/sqlComplete'
import { DIALECT_KEYWORDS, DIALECT_RESERVED } from '../src/core/sqlDialectData'

const col = (name: string, dataType = 'text', isPrimaryKey = false) => ({ name, dataType, isPrimaryKey })
const orders: CompletionTable = {
  schema: 'main', name: 'orders', kind: 'table',
  columns: [col('id', 'integer', true), col('customer_id', 'integer'), col('status')],
  foreignKeys: [{ name: 'orders_customer_fk', columns: ['customer_id'], refSchema: 'main', refTable: 'customers', refColumns: ['id'] }],
}
const customers: CompletionTable = {
  schema: 'main', name: 'customers', kind: 'table',
  columns: [col('id', 'integer', true), col('email')],
  foreignKeys: [],
}
const tables = [orders, customers]
const prefs: CompletionPrefs = { autoAlias: false, keywordCase: 'upper', snippets: true, joinByForeignKey: true, dialect: 'generic' }
const at = (sql: string, p: CompletionPrefs = prefs, ts: CompletionTable[] = tables) => completeAt(sql, sql.length, ts, p)
const labels = (sql: string, p?: CompletionPrefs, ts?: CompletionTable[]) => at(sql, p, ts).map((c) => c.label)
const find = (sql: string, label: string, p?: CompletionPrefs, ts?: CompletionTable[]) => at(sql, p, ts).find((c) => c.label === label)

describe('aliasFor', () => {
  it('uses initials for compound names and the first letter otherwise', () => {
    expect(aliasFor('order_items')).toBe('oi')
    expect(aliasFor('customers')).toBe('c')
  })
})

describe('qualified completion', () => {
  it('resolves alias. to that table’s columns (DataGrip alias awareness)', () => {
    const l = labels('select * from orders o where o.')
    expect(l).toEqual(expect.arrayContaining(['id', 'customer_id', 'status']))
    expect(l).not.toContain('email')
  })
  it('resolves table. without an alias', () => {
    expect(labels('select * from orders o order by orders.')).toEqual(expect.arrayContaining(['status']))
  })
  it('resolves schema. to its tables', () => {
    expect(labels('select * from main.')).toEqual(expect.arrayContaining(['orders', 'customers']))
  })
  it('replaces only the word at the caret', () => {
    const sql = 'select * from orders o where o.st'
    const c = find(sql, 'status')
    expect(c).toBeDefined()
    expect(sql.slice(c!.replaceStart, c!.replaceEnd)).toBe('st')
  })
})

describe('INSERT auto-fill', () => {
  it('suggests the missing columns of the target table', () => {
    const l = labels('insert into orders (')
    expect(l).toEqual(expect.arrayContaining(['id', 'customer_id', 'status']))
    expect(l).not.toContain('email')
  })
  it('excludes columns already listed', () => {
    expect(labels('insert into orders (id, ')).not.toContain('id')
    expect(labels('insert into orders (id, ')).toContain('status')
  })
})

describe('JOIN generation from foreign keys', () => {
  it('offers an outgoing FK join with a generated alias', () => {
    const c = find('select * from orders o join ', 'JOIN customers c')
    expect(c).toBeDefined()
    expect(c!.kind).toBe('join')
    expect(c!.insert).toBe('JOIN customers c ON c.id = o.customer_id')
  })
  it('offers an incoming FK join', () => {
    const c = find('select * from customers c join ', 'JOIN orders o')
    expect(c).toBeDefined()
    expect(c!.insert).toBe('JOIN orders o ON o.customer_id = c.id')
  })
  it('does not suggest tables already in scope', () => {
    expect(labels('select * from orders o join customers c on c.id = o.customer_id join ')).not.toContain('JOIN customers c')
  })
})

describe('defaults and preferences', () => {
  it('adds aliases when completing table names on request', () => {
    expect(find('select * from ', 'orders', { ...prefs, autoAlias: true })!.insert).toBe('orders o')
    expect(find('select * from ', 'orders')!.insert).toBe('orders')
  })
  it('honours the keyword case preference', () => {
    const lower = at('select * from orders', { ...prefs, keywordCase: 'lower' })
    expect(lower.map((c) => c.label)).toContain('where')
    expect(lower.map((c) => c.label)).not.toContain('WHERE')
  })
  it('qualifies duplicate table names with their schema', () => {
    const sales = { ...orders, schema: 'sales' }
    expect(find('select * from ', 'orders', prefs, [orders, sales])!.insert).toBe('main.orders')
  })
  it('offers live templates matching the typed prefix', () => {
    const c = find('sel', 'sel')
    expect(c?.kind).toBe('template')
    expect(c?.snippet).toBe(true)
    expect(c?.insert.startsWith('SELECT ')).toBe(true)
  })
  it('ranks columns of tables in scope above the rest', () => {
    const c = find('select * from orders o where st', 'status')
    expect(c?.kind).toBe('column')
    expect(c!.bucket).toBeLessThanOrEqual(2)
  })
  it('ranks the best match first (sqlRank ordering)', () => {
    const prefix = at('selec').filter((c) => c.label.toLowerCase().startsWith('selec'))
    expect(prefix[0]?.label).toBe('SELECT')
    // Kind priority (bucket) still dominates: keywords come before templates even when both match.
    const labels2 = at('sel').map((c) => c.label)
    expect(labels2.indexOf('SELECT')).toBeLessThan(labels2.indexOf('sel'))
  })
  it('lifts frequently used words within a bucket', () => {
    const usage = new Map([['state', 3]])
    const withState = [{ ...orders, columns: [...orders.columns, col('state')] }, customers]
    const l = labels('st', { ...prefs, usage }, withState)
    expect(l.indexOf('state')).toBeLessThan(l.indexOf('status'))
  })
})

describe('dialect catalogs (extracted from DataGrip)', () => {
  it('offers dialect-specific keywords', () => {
    expect(labels('retur', { ...prefs, dialect: 'postgres' })).toContain('RETURNING')
    expect(labels('soun', { ...prefs, dialect: 'mysql' })).toContain('SOUNDS')
    // The full vocabulary comes from the *Types classes: the *ReservedKeywords classes are
    // empty marker interfaces in several dialects (ClickHouse, Db2, ...).
    expect(labels('prewh', { ...prefs, dialect: 'clickhouse' })).toContain('PREWHERE')
    expect(labels('qualif', { ...prefs, dialect: 'clickhouse' })).toContain('QUALIFY')
    expect(labels('straight_jo', { ...prefs, dialect: 'mysql' })).toContain('STRAIGHT_JOIN')
    expect(labels('loo', { ...prefs, dialect: 'oracle' })).toContain('LOOP')
  })
  it('offers dialect-specific functions with prototypes', () => {
    const pg = find('abbre', 'abbrev', { ...prefs, dialect: 'postgres' })
    expect(pg?.kind).toBe('function')
    expect(pg?.insert).toBe('abbrev(')
    expect(pg?.detail).toContain('+1 overloads')
    expect(labels('abbre', { ...prefs, dialect: 'sqlite' })).not.toContain('abbrev')
  })
  it('gates templates per dialect like DataGrip contexts', () => {
    expect(find('top', 'top', { ...prefs, dialect: 'mssql' })).toBeDefined()
    expect(find('lim', 'lim', { ...prefs, dialect: 'mssql' })).toBeUndefined()
    expect(find('toprow', 'toprow', { ...prefs, dialect: 'oracle' })).toBeDefined()
    expect(find('lim', 'lim', { ...prefs, dialect: 'oracle' })).toBeUndefined()
    expect(find('first', 'first', { ...prefs, dialect: 'derby' })).toBeDefined()
    expect(find('lim', 'lim', { ...prefs, dialect: 'sqlite' })).toBeDefined()
  })
  it('never treats reserved words as implicit aliases', () => {
    // BETWEEN is reserved (SQL-92): `between.` must not resolve to orders' columns.
    expect(labels('select * from orders between where between.', prefs)).toEqual([])
    // Somewhere in the catalogs there are non-reserved keywords; those still work as implicit aliases.
    const scopeBreakers = new Set(['where', 'join', 'on', 'using', 'set', 'group', 'order', 'limit', 'offset',
      'having', 'union', 'values', 'select', 'from', 'window', 'returning', 'for', 'fetch', 'as', 'and', 'or', 'into'])
    const pick = Object.keys(DIALECT_KEYWORDS).map((d) => {
      const reserved = new Set(DIALECT_RESERVED[d].map((w) => w.toLowerCase()))
      const word = DIALECT_KEYWORDS[d].map((w) => w.toLowerCase())
        .find((w) => /^[a-z][a-z_]*$/.test(w) && !reserved.has(w) && !scopeBreakers.has(w))
      return { dialect: d as CompletionPrefs['dialect'], word }
    }).find((x) => x.word)
    expect(pick?.word).toBeTruthy()
    expect(labels(`select * from orders ${pick!.word} where ${pick!.word}.`, { ...prefs, dialect: pick!.dialect })).toContain('status')
  })
})
