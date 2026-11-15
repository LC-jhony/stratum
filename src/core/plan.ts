/** Execution-plan normalization: PostgreSQL/MySQL JSON and SQLite rows become one PlanNode tree. */
import type { DialectId, PlanNode, QueryPlan } from '../shared/types'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined)
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [])

/** Trim the trailing semicolons a console selection may include; EXPLAIN rejects multi-statement text. */
export const explainTarget = (sql: string): string => sql.trim().replace(/;+\s*$/, '')

/**
 * Statement that produces the plan for a dialect. PostgreSQL family and MySQL return structured
 * JSON, SQLite returns rows, everything else gets a plain textual EXPLAIN the viewer shows verbatim.
 */
export function explainStatement(dialect: DialectId, sql: string): { sql: string; parser: 'postgres' | 'mysql' | 'sqlite' | 'text' } | undefined {
  const target = explainTarget(sql)
  if (!target) return undefined
  if (['postgres', 'greenplum', 'cockroach', 'redshift', 'vertica'].includes(dialect)) return { sql: `EXPLAIN (FORMAT JSON, VERBOSE) ${target}`, parser: 'postgres' }
  if (dialect === 'mysql' || dialect === 'mariadb') return { sql: `EXPLAIN FORMAT=JSON ${target}`, parser: 'mysql' }
  if (dialect === 'sqlite') return { sql: `EXPLAIN QUERY PLAN ${target}`, parser: 'sqlite' }
  if (['mssql', 'oracle', 'db2', 'sybase', 'clickhouse', 'snowflake', 'hive', 'spark', 'bigquery', 'cassandra', 'h2', 'hsql', 'derby', 'exasol', 'generic'].includes(dialect)) return { sql: `EXPLAIN ${target}`, parser: 'text' }
  return undefined
}

/* ------------------------------------------------------------------ PostgreSQL */

export function pgPlanFromJson(value: unknown, sql: string, durationMs: number): QueryPlan {
  let raw = value
  if (typeof raw === 'string') raw = JSON.parse(raw) as unknown
  if (Array.isArray(raw)) raw = raw[0]
  const plan = isObj(raw) && isObj(raw.Plan) ? raw.Plan : raw
  if (!isObj(plan)) throw new Error('PostgreSQL returned an unexpected EXPLAIN payload.')
  return { dialect: 'postgres', format: 'json', sql, durationMs, root: pgNode(plan) }
}

function pgNode(p: Obj): PlanNode {
  const type = str(p['Node Type']) ?? 'Plan'
  const relation = str(p['Relation Name'])
  const index = str(p['Index Name'])
  const join = str(p['Join Type'])
  const parts = [
    relation && index ? `${relation} via ${index}` : relation ?? index,
    join && join !== 'Inner' ? `${join} join` : undefined,
    str(p['CTE Name']) && `CTE ${str(p['CTE Name'])}`,
    str(p['Subplan Name']),
  ].filter(Boolean) as string[]
  const conditions = [
    ['Filter', str(p.Filter)],
    ['Index Cond', str(p['Index Cond'])],
    ['Hash Cond', str(p['Hash Cond'])],
    ['Merge Cond', str(p['Merge Cond'])],
    ['Join Filter', str(p['Join Filter'])],
    ['Recheck Cond', str(p['Recheck Cond'])],
  ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`)
  const sort = list(p['Sort Key'])
  if (sort.length) conditions.push(`Sort: ${sort.join(', ')}`)
  const rows = num(p['Plan Rows'])
  const actual = num(p['Actual Rows'])
  const warnings: string[] = []
  if (/Seq Scan/i.test(type) && (rows ?? 0) >= 1000) warnings.push('Sequential scan over a large row estimate; check that an index is used.')
  if (/Sort/i.test(type) && (rows ?? 0) >= 10_000) warnings.push('Large sort; an index on the sort key may avoid it.')
  if ((num(p['Rows Removed by Filter']) ?? 0) > (actual ?? 0) && (num(p['Rows Removed by Filter']) ?? 0) > 1000) warnings.push('The filter discards more rows than it keeps.')
  const children = Array.isArray(p.Plans) ? p.Plans.filter(isObj).map(pgNode) : undefined
  return {
    label: type,
    detail: [...parts, ...conditions].join(' · ') || undefined,
    rows,
    cost: num(p['Total Cost']),
    actualRows: actual,
    actualTimeMs: num(p['Actual Total Time']),
    warning: warnings.length ? warnings.join(' ') : undefined,
    children,
  }
}

/* ------------------------------------------------------------------ MySQL */

const MYSQL_ACCESS: Record<string, string> = {
  ALL: 'full table scan', index: 'full index scan', range: 'range scan', ref: 'index lookup', eq_ref: 'unique lookup',
  const: 'constant', system: 'constant', ref_or_null: 'index lookup', index_merge: 'index merge', fulltext: 'full-text',
}

export function mysqlPlanFromJson(value: unknown, sql: string, durationMs: number): QueryPlan {
  let raw = value
  if (typeof raw === 'string') raw = JSON.parse(raw) as unknown
  if (Array.isArray(raw)) {
    // EXPLAIN FORMAT=JSON returns one row; a plain EXPLAIN returns many. Prefer the JSON column.
    const first = raw[0]
    const candidate = isObj(first) ? Object.values(first).find((v) => typeof v === 'string' && v.trim().startsWith('{')) ?? Object.values(first)[0] : first
    raw = typeof candidate === 'string' ? JSON.parse(candidate) as unknown : candidate
  }
  const root = isObj(raw) && isObj(raw.query_block) ? raw.query_block : raw
  if (!isObj(root)) throw new Error('MySQL returned an unexpected EXPLAIN payload.')
  return { dialect: 'mysql', format: 'json', sql, durationMs, root: mysqlBlock(root) }
}

function mysqlBlock(block: Obj): PlanNode {
  const selectId = num(block.select_id)
  const cost = isObj(block.cost_info) ? num(block.cost_info.query_cost) : undefined
  const children = mysqlChildren(block)
  return { label: selectId !== undefined ? `Query block #${selectId}` : 'Query block', cost, children: children.length ? children : undefined }
}

/** MySQL nests operations under descriptive keys; walk every known container and fall back generically. */
function mysqlChildren(obj: Obj): PlanNode[] {
  const out: PlanNode[] = []
  const nested = obj.nested_loop
  if (Array.isArray(nested)) {
    const loopChildren = nested.filter(isObj).flatMap(mysqlChildren)
    if (loopChildren.length) out.push({ label: 'Nested loop', children: loopChildren })
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'nested_loop' || key === 'select_id' || key === 'cost_info') continue
    if (key === 'table' && isObj(value)) { out.push(mysqlTable(value)); continue }
    if (Array.isArray(value)) {
      for (const item of value) if (isObj(item)) out.push(...(key === 'query_block' ? [mysqlBlock(item)] : mysqlOperation(key, item)))
      continue
    }
    if (isObj(value)) out.push(...mysqlOperation(key, value))
  }
  return out
}

function mysqlTable(t: Obj): PlanNode {
  const name = str(t.table_name) ?? str(t.table) ?? 'table'
  const access = str(t.access_type)
  const rows = num(t.rows_examined_per_scan) ?? num(t.rows_produced_per_join)
  const cost = isObj(t.cost_info) ? num(t.cost_info.read_cost) ?? num(t.cost_info.prefix_cost) : undefined
  const details = [
    access ? MYSQL_ACCESS[access] ?? access : undefined,
    str(t.key) && `key ${str(t.key)}`,
    num(t.rows_examined_per_scan) !== undefined ? `${num(t.rows_examined_per_scan)} rows examined` : undefined,
    str(t.using_index) === 'true' ? 'covering index' : undefined,
  ].filter(Boolean) as string[]
  const children = mysqlChildren(t)
  return {
    label: `Table ${name}`,
    detail: details.join(' · ') || undefined,
    rows,
    cost,
    warning: access === 'ALL' && (rows ?? 0) >= 1000 ? 'Full table scan; consider an index on the filtered columns.' : undefined,
    children: children.length ? children : undefined,
  }
}

const MYSQL_OPERATION: Record<string, string> = {
  ordering_operation: 'Sort', grouping_operation: 'Group by', duplicates_removal: 'Distinct', union_result: 'Union',
  materialized_from_subquery: 'Materialized subquery', attached_subqueries: 'Attached subqueries',
  optimized_away_subqueries: 'Optimized-away subqueries', select_list_subqueries: 'Select-list subqueries',
  having_subqueries: 'HAVING subqueries', order_by_subqueries: 'ORDER BY subqueries', group_by_subqueries: 'GROUP BY subqueries',
  query_block: 'Query block',
}

function mysqlOperation(key: string, value: Obj): PlanNode[] {
  if (key === 'query_block') return [mysqlBlock(value)]
  if (key === 'table') return [mysqlTable(value)]
  const label = MYSQL_OPERATION[key] ?? key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  const usingFilesort = value.using_filesort === true || str(value.using_filesort) === 'true'
  const usingTemporary = value.using_temporary_table === true || str(value.using_temporary_table) === 'true'
  const children = mysqlChildren(value)
  const details = [usingFilesort && 'filesort', usingTemporary && 'temporary table'].filter(Boolean) as string[]
  const rows = num(value.rows_produced_per_join) ?? num(value.rows_examined_per_scan)
  return [{
    label,
    detail: details.join(' · ') || undefined,
    rows,
    warning: usingFilesort && (rows ?? 0) >= 1000 ? 'Sorting with a filesort; an index on the ORDER BY columns may help.' : undefined,
    children: children.length ? children : undefined,
  }]
}

/* ------------------------------------------------------------------ SQLite */

export function sqlitePlanFromRows(rows: unknown[][], columns: { name: string }[], sql: string, durationMs: number): QueryPlan {
  const at = (name: string) => columns.findIndex((c) => c.name.toLowerCase() === name)
  const idAt = at('id'), parentAt = at('parent') >= 0 ? at('parent') : at('notused'), detailAt = at('detail')
  const byId = new Map<string, PlanNode>()
  const roots: PlanNode[] = []
  for (const row of rows) {
    const id = String(row[idAt] ?? row[0] ?? '')
    const parent = String(row[parentAt] ?? row[1] ?? '')
    const detail = String(row[detailAt] ?? row[row.length - 1] ?? '')
    const node: PlanNode = { label: sqliteLabel(detail), detail: sqliteDetail(detail), warning: sqliteWarning(detail) }
    byId.set(id, node)
    if (parent && byId.has(parent)) {
      const p = byId.get(parent)!
      p.children = [...(p.children ?? []), node]
    } else roots.push(node)
  }
  const root: PlanNode = roots.length === 1 ? roots[0] : { label: 'Query plan', children: roots.length ? roots : undefined }
  return { dialect: 'sqlite', format: 'json', sql, durationMs, root }
}

function sqliteLabel(detail: string): string {
  if (/^SEARCH\b/i.test(detail)) return 'Search'
  if (/^SCAN\b/i.test(detail)) return 'Scan'
  if (/^USE\b/i.test(detail)) return 'Sort / temporary structure'
  if (/^CO-ROUTINE\b/i.test(detail)) return 'Coroutine'
  if (/^MATERIALIZE\b/i.test(detail)) return 'Materialize'
  if (/^BLOOM\b/i.test(detail)) return 'Bloom filter'
  return 'Step'
}
const sqliteDetail = (detail: string): string | undefined => detail.replace(/^(SEARCH|SCAN|USE|CO-ROUTINE|MATERIALIZE|BLOOM)\s+/i, '').trim() || undefined
const sqliteWarning = (detail: string): string | undefined => {
  if (/^SCAN\b/i.test(detail) && !/USING\s+(COVERING\s+)?INDEX/i.test(detail)) return 'Full table scan; add an index for the filtered or joined columns.'
  if (/^USE\s+TEMP\s+B-TREE/i.test(detail)) return 'Sorting or grouping uses a temporary B-tree.'
  return undefined
}

/* ------------------------------------------------------------------ textual EXPLAIN */

export function textPlan(text: string, sql: string, durationMs: number, dialect: DialectId): QueryPlan {
  const trimmed = text.trim()
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim())
  const warning = /seq\s*scan|full\s*(table\s*)?scan|table\s+access\s+full|filesort/i.test(trimmed) ? 'The plan mentions a sequential/full scan.' : undefined
  return {
    dialect,
    format: 'text',
    sql,
    durationMs,
    raw: trimmed,
    root: { label: 'Execution plan', detail: lines[0]?.slice(0, 240), warning },
  }
}
