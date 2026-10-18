/**
 * Pure, context-aware SQL completion engine (DataGrip-style). No Monaco or DOM dependencies.
 *
 * Understands, from the text before the caret:
 *  - table aliases declared in FROM / JOIN / UPDATE / INSERT INTO (`orders o`)
 *  - `alias.` / `table.` / `schema.` / `schema.table.` qualifiers
 *  - INSERT INTO column lists (auto-fills remaining columns)
 *  - JOIN clauses generated from foreign keys (like DataGrip's generate-JOIN action)
 *  - DataGrip's SQL live templates (`sel`, `selw`, `selc`, `lim`, `top`, `ins`, …) with the
 *    dialect availability and descriptions DataGrip declares
 *  - per-dialect keyword and function catalogs extracted from DataGrip 2026.2.6
 *    (see `sqlDialectData.ts` and `scripts/datagrip-catalog.mjs`)
 *  - best-first ranking with DataGrip-like signals: match quality (exact/prefix/middle/greedy),
 *    shorter labels first and usage frequency (see `sqlRank.ts`)
 *
 * Heuristic, statement-local scanning: it does not parse comments/strings and ignores
 * comma-style joins. Position results replace the word at the caret.
 */
import { statementAt } from './sql'
import type { KeywordCase } from './settings'
import { rankCompletions } from './sqlRank'
import { DIALECT_FUNCTIONS, DIALECT_KEYWORDS, DIALECT_RESERVED, type DialectFunction } from './sqlDialectData'
import type { DialectId } from '../shared/types'

export interface CompletionTable {
  schema: string
  name: string
  kind: 'table' | 'view'
  columns: { name: string; dataType: string; isPrimaryKey: boolean }[]
  foreignKeys: { name: string; columns: string[]; refSchema: string; refTable: string; refColumns: string[] }[]
}
export interface CompletionPrefs {
  autoAlias: boolean
  keywordCase: KeywordCase
  snippets: boolean
  joinByForeignKey: boolean
  /** Active SQL dialect; drives the keyword, function and template catalogs. */
  dialect: DialectId
  /** Occurrences of each lowercased word in the document/session, used to rank candidates. */
  usage?: ReadonlyMap<string, number>
}
export type CompletionKind = 'column' | 'table' | 'view' | 'schema' | 'function' | 'keyword' | 'template' | 'join'
export interface Completion {
  label: string
  kind: CompletionKind
  detail?: string
  insert: string
  /** True when `insert` is a Monaco snippet (${1:placeholder} tab stops). */
  snippet?: boolean
  /** Lower values surface first. */
  bucket: number
  replaceStart: number
  replaceEnd: number
}

/** Multi-word statements/clauses layered on top of the extracted single-word catalogs. */
const EXTRA_KEYWORDS = ['group by', 'order by', 'insert into', 'delete from', 'left join', 'right join',
  'inner join', 'full join', 'cross join', 'outer join', 'is null', 'is not null', 'union all', 'create table',
  'create index', 'create view', 'alter table', 'drop table', 'truncate table', 'partition by', 'fetch first',
  'for update', 'tablesample', 'on conflict', 'do update', 'do nothing', 'distinct on', 'with recursive',
  'not in', 'not exists', 'begin transaction', 'commit work']
/** Words that can follow a table name but are never an implicit alias of it. */
const NO_ALIAS = new Set(['where', 'on', 'using', 'set', 'group', 'order', 'having', 'limit', 'offset', 'join',
  'left', 'right', 'inner', 'full', 'cross', 'natural', 'union', 'values', 'select', 'from', 'as', 'and', 'or',
  'when', 'then', 'else', 'end', 'returning', 'window', 'for', 'fetch', 'tablesample', 'lateral'])

interface DialectCatalog {
  keywords: string[]
  functions: DialectFunction[]
  /** Lowercased reserved words (dialect catalog + curated list): never an implicit alias. */
  reserved: Set<string>
}
const catalogs = new Map<DialectId, DialectCatalog>()
function catalogFor(dialect: DialectId): DialectCatalog {
  let c = catalogs.get(dialect)
  if (!c) {
    const words = [...(DIALECT_KEYWORDS[dialect] ?? DIALECT_KEYWORDS.generic ?? []).map(low), ...EXTRA_KEYWORDS]
    c = {
      keywords: words.filter((w, i) => words.indexOf(w) === i),
      functions: DIALECT_FUNCTIONS[dialect] ?? [],
      reserved: new Set([...(DIALECT_RESERVED[dialect] ?? []).map(low), ...NO_ALIAS]),
    }
    catalogs.set(dialect, c)
  }
  return c
}

type KeywordFn = (s: string) => string
interface SqlTemplate {
  prefix: string
  detail: string
  /** Dialects that offer the template; omitted means all of them. */
  available?: (d: DialectId) => boolean
  build: (k: KeywordFn, d: DialectId) => string
}
const notIn = (...excluded: DialectId[]) => (d: DialectId) => !excluded.includes(d)
const onlyIn = (...list: DialectId[]) => (d: DialectId) => list.includes(d)

/** DataGrip's SQL live templates (liveTemplates/sqlLiveTemplates.xml in sql.impl.jar) plus `jo`/`lj`. */
const SQL_TEMPLATES: SqlTemplate[] = [
  { prefix: 'sel', detail: 'select all rows from a table',
    build: (k) => k('select') + ' * ' + k('from') + ' ${1:table_name}$0;' },
  { prefix: 'selw', detail: 'select specific rows from a table',
    build: (k) => k('select') + ' * ' + k('from') + ' ${1:table_name} ${2:alias} ' + k('where') + ' ${2:alias}.$0;' },
  { prefix: 'selc', detail: 'select the number of specific rows in a table',
    build: (k) => k('select') + ' count(*) ' + k('from') + ' ${1:table_name} ${2:alias} ' + k('where') + ' ${2:alias}.$0;' },
  { prefix: 'lim', detail: 'select first N rows from a table', available: notIn('db2', 'derby', 'mssql', 'oracle'),
    build: (k) => k('select') + ' * ' + k('from') + ' ${1:table_name} ' + k('limit') + ' ${2:100}$0;' },
  { prefix: 'top', detail: 'select first N rows from a table', available: onlyIn('mssql'),
    build: (k) => k('select') + ' ' + k('top') + ' ${2:100} * ' + k('from') + ' ${1:table_name}$0;' },
  { prefix: 'first', detail: 'select first N rows from a table', available: onlyIn('db2', 'derby'),
    build: (k) => k('select') + ' * ' + k('from') + ' ${1:table_name} ' + k('fetch first') + ' ${2:100} ' + k('rows only') + '$0;' },
  { prefix: 'toprow', detail: 'select first N rows from a table', available: onlyIn('oracle'),
    build: (k) => k('select') + ' * ' + k('from') + ' ${1:table_name} ' + k('where') + ' rownum <= ${2:100}$0;' },
  { prefix: 'ins', detail: 'insert rows into a table',
    build: (k) => k('insert into') + ' ${1:table_name} (${2:columns}) ' + k('values') + ' (${3:values})$0;' },
  { prefix: 'upd', detail: 'update values in a table', available: notIn('clickhouse'),
    build: (k) => k('update') + ' ${1:table_name} ' + k('set') + ' ${2:column} = ${3:value} ' + k('where') + ' $0;' },
  { prefix: 'del', detail: 'delete rows from a table', available: notIn('clickhouse'),
    build: (k) => k('delete from') + ' ${1:table_name} ' + k('where') + ' $0;' },
  { prefix: 'tab', detail: 'new table definition',
    build: (k, d) => k('create table') + ' ${1:new_table} (\n  ${2:column} ${3:int}' + (d === 'cassandra' ? '$0' : ' ${4:not null}$0') + '\n);' },
  { prefix: 'view', detail: 'new view definition', available: notIn('cassandra'),
    build: (k) => k('create view') + ' ${1:new_view} ' + k('as') + ' ' + k('select') + ' * ' + k('from') + ' ${2:table_name} $0;' },
  { prefix: 'col', detail: 'new column definition',
    build: (k, d) => '${1:column} ${2:int}' + (d === 'cassandra' ? '$0' : ' ${3:not null}$0') },
  { prefix: 'jo', detail: 'JOIN … ON …', available: notIn('cassandra'),
    build: (k) => k('join') + ' ${1:table_name} ${2:alias} ' + k('on') + ' ${2:alias}.${3:column} = ${4:expression}' },
  { prefix: 'lj', detail: 'LEFT JOIN … ON …', available: notIn('cassandra'),
    build: (k) => k('left join') + ' ${1:table_name} ${2:alias} ' + k('on') + ' ${2:alias}.${3:column} = ${4:expression}' },
]

const IDENT = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[\\w$]+)'
const strip = (s: string) => s.replace(/^["`[]/, '').replace(/["`\]]$/, '')
const low = (s: string) => s.toLowerCase()
const kw = (s: string, c: KeywordCase) => (c === 'upper' ? s.toUpperCase() : s.toLowerCase())

/** Generated alias for a table: order_items -> oi, customers -> c. */
export function aliasFor(name: string): string {
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (!parts.length) return 't'
  return parts.length > 1 ? parts.map((p) => p[0]).join('').toLowerCase() : parts[0][0].toLowerCase()
}

const sameTable = (t: CompletionTable, schema: string | undefined, name: string) => low(t.name) === low(name) && (schema === undefined || low(t.schema) === low(schema))
const findTable = (tables: CompletionTable[], schema: string | undefined, name: string) => tables.find((t) => sameTable(t, schema, name))
const isRefOf = (refSchema: string, refTable: string, t: CompletionTable) => low(refSchema) === low(t.schema) && low(refTable) === low(t.name)

interface ScopeEntry { table: CompletionTable; alias: string | null }

/** Tables (with aliases) visible to the current statement, scanned from its beginning to the caret. */
function scopeTables(before: string, tables: CompletionTable[], reserved: Set<string>): ScopeEntry[] {
  const out: ScopeEntry[] = []
  const re = new RegExp(`\\b(from|join|update|into)\\s+(${IDENT}(?:\\.${IDENT})?)(?:\\s+as\\s+([A-Za-z_$][\\w$]*))?(?:\\s+([A-Za-z_$][\\w$]*))?`, 'gi')
  for (const m of before.matchAll(re)) {
    const parts = m[2].split('.').map(strip)
    const table = findTable(tables, parts.length > 1 ? parts[parts.length - 2] : undefined, parts[parts.length - 1])
    if (!table) continue
    const explicit = m[3], implicit = m[4]
    const alias = explicit ?? (implicit && !reserved.has(low(implicit)) ? implicit : null)
    if (!out.some((e) => e.table === table && low(e.alias ?? '') === low(alias ?? ''))) out.push({ table, alias })
  }
  return out
}

export function completeAt(sql: string, offset: number, tables: CompletionTable[], prefs: CompletionPrefs): Completion[] {
  const st = statementAt(sql, offset)
  const from = st ? Math.min(st.start, offset) : 0
  // Slice the raw text (not the trimmed statement text) so a just-typed trailing space still drives context detection.
  const before = sql.slice(from, offset)
  const word = /[A-Za-z0-9_$]*$/.exec(before)?.[0] ?? ''
  const replaceStart = offset - word.length
  const replaceEnd = offset
  const out: Completion[] = []
  const push = (c: Omit<Completion, 'replaceStart' | 'replaceEnd'>) => out.push({ ...c, replaceStart, replaceEnd })
  const finish = (items: Completion[]) => rankCompletions(items, { word, usage: prefs.usage })
  const { keywords, functions, reserved } = catalogFor(prefs.dialect)
  const scope = scopeTables(before, tables, reserved)

  // 1) Qualified completion: `alias.` / `table.` / `schema.` / `schema.table.`
  const qual = new RegExp(`(${IDENT}(?:\\.${IDENT})*)\\.\\s*[A-Za-z0-9_$]*$`).exec(before)?.[1]
  if (qual) {
    const parts = qual.split('.').map(strip)
    const last = parts[parts.length - 1]
    if (parts.length === 1) {
      const target = scope.find((e) => low(e.alias ?? e.table.name) === low(last))?.table
        ?? findTable(tables, undefined, last)
      if (!target) { // schema qualifier -> its tables
        for (const t of tables) if (low(t.schema) === low(last)) push({ label: t.name, kind: t.kind, detail: t.schema, insert: t.name, bucket: 0 })
        return finish(out)
      }
      for (const c of target.columns) push({ label: c.name, kind: 'column', detail: `${c.dataType}${c.isPrimaryKey ? ' · pk' : ''}`, insert: c.name, bucket: 0 })
      return finish(out)
    }
    const target = findTable(tables, parts[parts.length - 2], parts[parts.length - 1]) ?? findTable(tables, undefined, parts[parts.length - 1])
    if (target) for (const c of target.columns) push({ label: c.name, kind: 'column', detail: `${c.dataType}${c.isPrimaryKey ? ' · pk' : ''}`, insert: c.name, bucket: 0 })
    return finish(out)
  }

  // 2) INSERT INTO t ( ... -> remaining columns of t
  const ins = new RegExp(`\\binsert\\s+into\\s+(${IDENT}(?:\\.${IDENT})?)\\s*\\(\\s*([\\w$,\\s"\`\\[\\]]*)$`, 'i').exec(before)
  if (ins) {
    const parts = ins[1].split('.').map(strip)
    const target = findTable(tables, parts.length > 1 ? parts[parts.length - 2] : undefined, parts[parts.length - 1])
    const segs = ins[2].split(',')
    const done = ins[2].trimEnd().endsWith(',') ? segs : segs.slice(0, -1)
    const listed = new Set(done.map((s) => low(strip(s.trim()))).filter(Boolean))
    if (target) for (const c of target.columns) if (!listed.has(low(c.name))) push({ label: c.name, kind: 'column', detail: c.dataType, insert: c.name, bucket: 0 })
    return finish(out)
  }

  // 3) JOIN completion from foreign keys (right after `join`), like DataGrip's generate-JOIN
  if (prefs.joinByForeignKey && new RegExp(`\\bjoin\\s+[\\w$"\`\\[]*$`, 'i').test(before)) {
    const used = new Set(scope.map((e) => low(e.alias ?? '')).filter(Boolean))
    const fresh = (name: string) => { let a = aliasFor(name), i = 2; while (used.has(a)) a = `${aliasFor(name)}${i++}`; used.add(a); return a }
    for (const e of scope) {
      if (!e.alias) continue
      const a = e.alias, J = kw('join', prefs.keywordCase), ON = kw('on', prefs.keywordCase)
      for (const fk of e.table.foreignKeys) { // outgoing: this table -> referenced table
        const ref = findTable(tables, fk.refSchema, fk.refTable)
        if (!ref || scope.some((x) => x.table === ref)) continue
        const a2 = fresh(ref.name)
        const on = fk.columns.map((c, i) => `${a2}.${fk.refColumns[i] ?? '?'} = ${a}.${c}`).join(` ${kw('and', prefs.keywordCase)} `)
        push({ label: `${kw('join', prefs.keywordCase)} ${ref.name} ${a2}`, kind: 'join', detail: `${ON} ${on} · ${fk.name}`, insert: `${J} ${ref.name} ${a2} ${ON} ${on}`, bucket: 0 })
      }
      for (const other of tables) for (const fk of other.foreignKeys) { // incoming: tables referencing this one
        if (!isRefOf(fk.refSchema, fk.refTable, e.table) || scope.some((x) => x.table === other)) continue
        const a2 = fresh(other.name)
        const on = fk.columns.map((c, i) => `${a2}.${c} = ${a}.${fk.refColumns[i] ?? '?'}`).join(` ${kw('and', prefs.keywordCase)} `)
        push({ label: `${kw('join', prefs.keywordCase)} ${other.name} ${a2}`, kind: 'join', detail: `${ON} ${on} · ${fk.name}`, insert: `${J} ${other.name} ${a2} ${ON} ${on}`, bucket: 0 })
      }
    }
  }

  // 4) Default catalog: tables, columns, dialect functions/keywords, templates
  const fromContext = new RegExp(`\\b(from|join|into|update|table)\\s+[\\w$"\`\\[\\].]*$`, 'i').test(before)
  const nameCount = new Map<string, number>()
  for (const t of tables) nameCount.set(low(t.name), (nameCount.get(low(t.name)) ?? 0) + 1)
  for (const t of tables) push({
    label: t.name, kind: t.kind, detail: t.schema, bucket: fromContext ? 1 : 3,
    insert: prefs.autoAlias && fromContext ? `${t.name} ${aliasFor(t.name)}` : (nameCount.get(low(t.name)) ?? 0) > 1 ? `${t.schema}.${t.name}` : t.name,
  })
  const inScope = new Set(scope.map((e) => e.table))
  const seen = new Set<string>()
  const cols = [...scope.map((e) => e.table), ...tables.filter((t) => !inScope.has(t))]
  for (const t of cols) for (const c of t.columns) {
    if (seen.has(low(c.name))) continue
    seen.add(low(c.name))
    push({ label: c.name, kind: 'column', detail: `${t.name}.${c.dataType}`, insert: c.name, bucket: inScope.has(t) ? 2 : 4 })
  }
  for (const f of functions) {
    const [name, sig] = f
    const noArgs = !sig || sig === '()' || /^\(void\)/i.test(sig)
    push({ label: name, kind: 'function', detail: sig + (f[2] > 1 ? ` · +${f[2] - 1} overloads` : ''), insert: noArgs ? name : `${name}(`, bucket: 5 })
  }
  for (const k of keywords) push({ label: kw(k, prefs.keywordCase), kind: 'keyword', insert: kw(k, prefs.keywordCase), bucket: 6 })
  if (prefs.snippets) for (const t of SQL_TEMPLATES) {
    if (t.available && !t.available(prefs.dialect)) continue
    if (word && !t.prefix.startsWith(low(word))) continue
    push({ label: t.prefix, kind: 'template', detail: t.detail, insert: t.build((s) => kw(s, prefs.keywordCase), prefs.dialect), snippet: true, bucket: 7 })
  }
  return finish(out)
}
