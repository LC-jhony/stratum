/**
 * SQL parameter detection and substitution (DataGrip-style).
 *
 * Patterns transcribed from DataGrip's `parameter-patterns`
 * (options/databaseSettings.xml): `${name}`, `$(name)`, `#name#` and JDBC/PL-SQL style
 * `:name` / `:'name'` / `:"name"`. A quoted form inserts an escaped SQL literal; the
 * plain form substitutes the typed text as-is, like DataGrip does.
 */
import type { DialectId } from '../shared/types'

export interface SqlParam {
  /** Parameter name as typed (without delimiters). */
  name: string
  /** Exact source text (`:id`, `:'id'`, `${id}` …). */
  raw: string
  start: number
  end: number
  /** How the value is rendered: escaped string, escaped identifier, number-or-quoted (bind-style) or verbatim. */
  kind: 'string' | 'identifier' | 'auto' | 'raw'
}

/** Dialects whose SQL clients accept `:name` bind-style parameters. */
const COLON = new Set<DialectId>(['postgres', 'greenplum', 'cockroach', 'redshift', 'vertica', 'exasol', 'snowflake',
  'oracle', 'db2', 'derby', 'h2', 'hsql', 'sqlite', 'generic'])

interface Pattern { re: RegExp; kind: SqlParam['kind']; colon?: boolean }
const PATTERNS: Pattern[] = [
  { re: /:'([^']+)'/g, kind: 'string', colon: true },
  { re: /:"([^"]+)"/g, kind: 'identifier', colon: true },
  { re: /(?<![:\w]):([A-Za-z_]\w*)\b/g, kind: 'auto', colon: true },
  { re: /\$\{([^{}]+)\}/g, kind: 'raw' },
  { re: /\$\(([^()]+)\)/g, kind: 'raw' },
  { re: /#([A-Za-z_]\w*)#/g, kind: 'raw' },
]

/** All parameters in `sql`, left to right, without overlaps (first matching pattern wins). */
export function findParams(sql: string, dialect: DialectId): SqlParam[] {
  const out: SqlParam[] = []
  const claimed: [number, number][] = []
  for (const p of PATTERNS) {
    if (p.colon && !COLON.has(dialect)) continue
    for (const m of sql.matchAll(p.re)) {
      const start = m.index!
      const end = start + m[0].length
      if (claimed.some(([a, b]) => start < b && end > a)) continue
      claimed.push([start, end])
      out.push({ name: m[1], raw: m[0], start, end, kind: p.kind })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

const render = (p: SqlParam, v: string): string => {
  if (p.kind === 'string') return `'${v.replace(/'/g, "''")}'`
  if (p.kind === 'identifier') return `"${v.replace(/"/g, '""')}"`
  // Bind-style (`:name`): numbers, NULL and booleans stay bare; anything else becomes a literal.
  if (p.kind === 'auto') return /^-?\d+(\.\d+)?$/.test(v.trim()) || /^(null|true|false)$/i.test(v.trim()) ? v.trim() : `'${v.replace(/'/g, "''")}'`
  return v
}

/** Replace each parameter with its value. Parameters without a value stay untouched. */
export function substituteParams(sql: string, params: SqlParam[], values: Record<string, string>): string {
  let out = sql
  for (const p of [...params].sort((a, b) => b.start - a.start)) {
    const v = values[p.name]
    if (v === undefined) continue
    out = out.slice(0, p.start) + render(p, v) + out.slice(p.end)
  }
  return out
}
