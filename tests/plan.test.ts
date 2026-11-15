import { describe, expect, it } from 'vitest'
import { explainStatement, mysqlPlanFromJson, pgPlanFromJson, sqlitePlanFromRows, textPlan } from '../src/core/plan'

describe('execution plan parsing', () => {
  it('picks the right EXPLAIN statement per dialect', () => {
    expect(explainStatement('postgres', 'select * from t;')).toEqual({ sql: 'EXPLAIN (FORMAT JSON, VERBOSE) select * from t', parser: 'postgres' })
    expect(explainStatement('mysql', 'select 1')?.sql).toBe('EXPLAIN FORMAT=JSON select 1')
    expect(explainStatement('sqlite', 'select 1')?.sql).toBe('EXPLAIN QUERY PLAN select 1')
    expect(explainStatement('oracle', 'select 1')?.parser).toBe('text')
    expect(explainStatement('cassandra', 'select 1')?.parser).toBe('text')
    expect(explainStatement('postgres', '   ')).toBeUndefined()
  })

  it('turns PostgreSQL JSON into a tree with warnings', () => {
    const plan = pgPlanFromJson([{ Plan: {
      'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Plan Rows': 5000, 'Total Cost': 120.4,
      Filter: '(status = 1)', Plans: [{ 'Node Type': 'Index Scan', 'Index Name': 'orders_pkey', 'Plan Rows': 1 }],
    } }], 'select * from orders', 12)
    expect(plan.root.label).toBe('Seq Scan')
    expect(plan.root.detail).toContain('orders')
    expect(plan.root.rows).toBe(5000)
    expect(plan.root.warning).toMatch(/Sequential scan/)
    expect(plan.root.children?.[0].label).toBe('Index Scan')
  })

  it('turns MySQL JSON into a tree with table access warnings', () => {
    const plan = mysqlPlanFromJson({
      query_block: {
        select_id: 1,
        cost_info: { query_cost: '42.5' },
        nested_loop: [{ table: { table_name: 'orders', access_type: 'ALL', rows_examined_per_scan: 4000, cost_info: { read_cost: '30' } } }],
      },
    }, 'select * from orders', 5)
    const loop = plan.root.children?.[0]
    expect(loop?.label).toBe('Nested loop')
    expect(loop?.children?.[0].label).toBe('Table orders')
    expect(loop?.children?.[0].rows).toBe(4000)
    expect(loop?.children?.[0].warning).toMatch(/Full table scan/)
  })

  it('builds a SQLite tree from (id, parent, notused, detail) rows', () => {
    const plan = sqlitePlanFromRows(
      [[2, 0, 0, 'SCAN orders'], [3, 0, 0, 'USE TEMP B-TREE FOR ORDER BY']],
      [{ name: 'id' }, { name: 'parent' }, { name: 'notused' }, { name: 'detail' }],
      'select * from orders order by id', 1,
    )
    expect(plan.root.children).toHaveLength(2)
    expect(plan.root.children?.[0].label).toBe('Scan')
    expect(plan.root.children?.[0].warning).toMatch(/Full table scan/)
    expect(plan.root.children?.[1].warning).toMatch(/temporary B-tree/)
  })

  it('keeps textual EXPLAIN output for databases without a JSON plan', () => {
    const plan = textPlan('Plan hash value: 123\n| Id | Operation |\n| 0 | TABLE ACCESS FULL |', 'select 1', 3, 'oracle')
    expect(plan.format).toBe('text')
    expect(plan.raw).toContain('TABLE ACCESS FULL')
    expect(plan.root.warning).toBeTruthy()
  })
})
