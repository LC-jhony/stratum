import type { StatementRange } from './sql'

/**
 * Statement utilities for the Elasticsearch console (Dev Tools-style text).
 *
 * A statement opens on a line that starts with an HTTP method and a `/path`, or with Stratum's own
 * paged reader `SEARCH <index>`, and runs through the following lines — which normally carry the
 * JSON request body. Like Kibana's Dev Tools console, a request is recognised by its opening line,
 * so a JSON body line never splits a statement; nothing here performs HTTP.
 *
 * Only relative paths are accepted (never absolute URLs), so the console can never make Stratum
 * fetch an arbitrary host.
 */
export function splitElasticStatements(text: string): StatementRange[] {
  const out: StatementRange[] = []
  const lines: { start: number; end: number; text: string }[] = []
  let pos = 0
  for (const line of text.split('\n')) {
    lines.push({ start: pos, end: pos + line.length, text: line })
    pos += line.length + 1
  }
  let cur: { start: number; end: number } | undefined
  const push = () => {
    if (!cur) return
    const raw = text.slice(cur.start, cur.end)
    const trimmed = raw.trim()
    if (trimmed) {
      const lead = raw.length - raw.trimStart().length
      out.push({ start: cur.start + lead, end: cur.start + lead + trimmed.length, text: trimmed })
    }
    cur = undefined
  }
  for (const l of lines) {
    if (START_LINE.test(l.text)) { push(); cur = { start: l.start, end: l.end } }
    else if (cur && l.text.trim()) cur.end = l.end
  }
  push()
  return out
}

/** A statement opens with `METHOD /path…` or the internal `SEARCH …` reader. */
const START_LINE = /^[ \t]*(?:(?:GET|POST|HEAD|PUT|PATCH|DELETE)[ \t]+\/|SEARCH(?:[ \t]|$))/i

/** Statement containing the caret; if the caret sits in whitespace, the closest preceding statement. */
export function elasticStatementAt(text: string, offset: number): StatementRange | undefined {
  const all = splitElasticStatements(text)
  if (!all.length) return undefined
  const hit = all.find((s) => offset >= s.start && offset <= s.end)
  if (hit) return hit
  const before = [...all].reverse().find((s) => s.end < offset)
  return before ?? all[0]
}

/* ------------------------------------------------------------------ request parsing */

export interface ElasticRequest {
  /** True for Stratum's paged reader (`SEARCH <index> <offset> <count>`), not typed by users. */
  internal?: boolean
  method: string
  path: string
  /** Raw JSON request body, when the statement has one. */
  body?: string
  /** SEARCH arguments: index, offset, count. */
  args: string[]
}

const METHODS = new Set(['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'DELETE'])
const INTERNAL = /^SEARCH(?:[ \t]|$)/i
const SEARCH_ARGS = /^("(?:[^"\\]|\\.)*"|\S+)(?:[ \t]+(\d+))?(?:[ \t]+(\d+))?$/
const FIRST_LINE = /^([A-Za-z]+)[ \t]+(\S+)(?:[ \t]+(.*))?$/

/** Parses one statement into method/path/body (or the internal SEARCH arguments); undefined when it is neither. */
export function parseElasticRequest(text: string): ElasticRequest | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (INTERNAL.test(trimmed)) {
    const rest = trimmed.replace(INTERNAL, '').trim()
    const m = SEARCH_ARGS.exec(rest)
    let index = m?.[1] ?? ''
    if (index.startsWith('"')) { try { index = String(JSON.parse(index)) } catch { /* keep the raw token */ } }
    return { internal: true, method: 'GET', path: '', args: [index, m?.[2], m?.[3]].filter((x): x is string => !!x) }
  }
  const first = trimmed.split('\n', 1)[0]
  const m = FIRST_LINE.exec(first.trim())
  if (!m) return undefined
  const method = m[1].toUpperCase()
  if (!METHODS.has(method)) return undefined
  const path = m[2]
  if (!path.startsWith('/')) return undefined
  const rest = trimmed.slice(first.length).replace(/^\n/, '')
  const body = [m[3] ?? '', rest].filter((x) => x !== '').join('\n').trim() || undefined
  return { method, path, body, args: [] }
}

/* ------------------------------------------------------------------ read-only policy */

/** POST is write-capable; only these endpoint families are genuine reads. */
const READ_POST_PATHS = /(?:\/_search|\/_search\/template|\/_msearch|\/_count|\/_field_caps|\/_knn_search|\/_search_shards|\/_validate\/query|\/_analyze|\/_explain|\/_termvectors|\/_mtermvectors|\/_render\/template)$/

/** True when a POST to this path is a read. Shared by the allowlist and by the GET-with-body upgrade. */
export function isElasticReadPost(path: string): boolean {
  return READ_POST_PATHS.test(path.split('?')[0])
}

/** `GET`/`HEAD` read by definition; `POST` only on read endpoints; everything else is blocked. */
export function isElasticRead(stmt: string): boolean {
  const req = parseElasticRequest(stmt)
  if (!req) return false
  if (req.internal) return true
  if (req.method === 'GET' || req.method === 'HEAD') return true
  return req.method === 'POST' && isElasticReadPost(req.path)
}

/** Search requests get from/size so the grid and console page them like every other provider. */
export function paginateElasticStatement(sql: string, limit: number, offset: number): string | undefined {
  const req = parseElasticRequest(sql)
  if (!req) return undefined
  if (req.internal) return req.args[0] ? `SEARCH ${JSON.stringify(req.args[0])} ${offset} ${limit}` : undefined
  if ((req.method === 'GET' || req.method === 'POST') && /\/_search$/.test(req.path.split('?')[0])) {
    const [path, query] = splitPath(req.path)
    const params = new URLSearchParams(query)
    params.set('from', String(offset))
    params.set('size', String(limit))
    return `${req.method} ${path}?${params.toString()}${req.body ? `\n${req.body}` : ''}`
  }
  return undefined
}

const splitPath = (path: string): [string, string] => {
  const i = path.indexOf('?')
  return i < 0 ? [path, ''] : [path.slice(0, i), path.slice(i + 1)]
}
