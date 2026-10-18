/**
 * Statement utilities for the Cassandra console (CQL, cqlsh-style text).
 *
 * Splitting reuses the SQL splitter (CQL also ends statements at `;` and quotes with single
 * quotes); this module classifies statements for the read-only gate and builds the paging header
 * the transport understands, because CQL has no `OFFSET`: a read is re-run from the first row and
 * the transport walks Cassandra's native page states until it reaches the requested window.
 *
 * The console accepts `SELECT`, `USE` (the transport tracks the current keyspace per session) and
 * the client-side `DESCRIBE` helpers; everything else is rejected before reaching the cluster.
 */
export interface CassandraPage {
  offset: number
  limit: number
  cql: string
}

const MAX_IDENT = /^\s*USE\s+("(?:[^"]|"")*"|[A-Za-z][A-Za-z0-9_]*)\s*;?\s*$/i

/** First keyword of a statement, skipping whitespace, `--`/`//` line comments and block comments. */
export function cqlHead(stmt: string): string {
  let s = stmt
  for (;;) {
    s = s.replace(/^\s+/, '')
    if (s.startsWith('--') || s.startsWith('//')) {
      const i = s.indexOf('\n')
      s = i < 0 ? '' : s.slice(i + 1)
      continue
    }
    if (s.startsWith('/*')) {
      const i = s.indexOf('*/', 2)
      s = i < 0 ? '' : s.slice(i + 2)
      continue
    }
    break
  }
  return (/^[A-Za-z]+/.exec(s)?.[0] ?? '').toUpperCase()
}

/** Reads are `SELECT`, `USE` (session state only) and the client-side `DESCRIBE` helpers. */
export function isCassandraRead(stmt: string): boolean {
  const head = cqlHead(stmt)
  return head === 'SELECT' || head === 'USE' || head === 'DESCRIBE'
}

/** Reads gain a `PAGE <offset> <limit>` header the transport walks page by page. */
export function paginateCassandraStatement(sql: string, limit: number, offset: number): string | undefined {
  const trimmed = sql.trim()
  if (!trimmed || !isCassandraRead(trimmed)) return undefined
  return `PAGE ${offset} ${limit}\n${trimmed}`
}

/** Reads back the header written by `paginateCassandraStatement`; undefined for console statements. */
export function parseCassandraPage(stmt: string): CassandraPage | undefined {
  const m = /^PAGE[ \t]+(\d+)[ \t]+(\d+)\r?\n([\s\S]+)$/.exec(stmt)
  if (!m) return undefined
  const cql = m[3].trim()
  if (!cql) return undefined
  return { offset: Number(m[1]), limit: Number(m[2]), cql }
}

/** `USE "Main"` → `Main` (quoted, exact) or `use events` → `events` (unquoted CQL folds to lower case). */
export function parseCassandraUse(stmt: string): string | undefined {
  const m = MAX_IDENT.exec(stmt)
  if (!m) return undefined
  const raw = m[1]
  return raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw.toLowerCase()
}

/** Identifier used by `DESCRIBE TABLE ks.tbl` (same folding rules as `USE`). */
export function cassandraIdent(raw: string): string {
  return raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw.toLowerCase()
}
