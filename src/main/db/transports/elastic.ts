import type { ColumnInfo, ColumnMeta, ConnectionConfig, RawResult, SchemaInfo, TableInfo } from '../../../shared/types'
import { isElasticRead, isElasticReadPost, parseElasticRequest } from '../../../core/elastic'
import type { Transport } from '../types'

/**
 * Elasticsearch transport (read-only MVP).
 *
 * The console speaks the Dev Tools dialect: `GET /_cat/indices?format=json`,
 * `POST /my-index/_search` followed by a JSON body. Reads are classified by method — `GET`/`HEAD`
 * always, `POST` only on search/count/analysis endpoints — and anything else fails with a clear
 * message in the results pane before a single byte leaves the process. Only relative paths are
 * accepted, so the console can never be pointed at another host.
 *
 * Search responses (`_search`, and the grid's own `SEARCH <index>` reader) become rows with `_id`
 * plus the flattened `_source` fields; `_cat/*` tables and plain objects map generically. The
 * explorer model lists indices as tables under one `indices` schema and reads each mapping for
 * columns (bounded by index count and a time budget, like the key sampling of Redis).
 *
 * Writes are out of scope by design (like the MongoDB and Redis MVPs): every mutating method or
 * endpoint is rejected before reaching the cluster.
 */

const DEFAULT_PORT = 9200
const REQUEST_TIMEOUT_MS = 15_000
const MAX_INDICES = 300
const MAX_MAPPING_INDICES = 60
const MAX_FIELDS = 200
const MAX_ROWS = 2000
const TIME_BUDGET_MS = 8000

const valueCol = (name = 'value'): ColumnMeta[] => [{ name }]
const scalar = (v: unknown): RawResult => ({ columns: valueCol(), rows: [[v]] })

/* ------------------------------------------------------------------ replies to grid rows */

export function replyToResult(json: unknown): RawResult {
  if (json === null || json === undefined) return scalar(null)
  if (isSearchResponse(json)) return hitsToResult(json)
  if (Array.isArray(json)) {
    if (!json.length) return { columns: [], rows: [] }
    if (json.some((x) => x && typeof x === 'object' && !Array.isArray(x))) return arrayOfObjects(json)
    return { columns: valueCol(), rows: json.map((v) => [v]) }
  }
  if (typeof json === 'object') return { columns: [{ name: 'key' }, { name: 'value' }], rows: Object.entries(json as Record<string, unknown>) }
  return scalar(json)
}

/** `[{"index": "users", …}, …]` (`_cat/*?format=json`) → one column per key, union'd across rows. */
function arrayOfObjects(items: unknown[]): RawResult {
  const keys: string[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    for (const k of Object.keys(item)) if (!keys.includes(k)) keys.push(k)
  }
  const rows = items.map((item) => keys.map((k) => (item && typeof item === 'object' ? (item as Record<string, unknown>)[k] ?? null : null)))
  return { columns: keys.map((name) => ({ name })), rows }
}

const isSearchResponse = (json: unknown): boolean =>
  !!json && typeof json === 'object' && Array.isArray((json as { hits?: { hits?: unknown } }).hits?.hits)

/** Elasticsearch `_search` hits → `_id` plus flattened source fields, union'd across the page. */
export function hitsToResult(json: unknown): RawResult {
  const hits = ((json as { hits?: { hits?: unknown[] } }).hits?.hits ?? []) as unknown[]
  const maps = hits.map((h) => {
    const hit = (h ?? {}) as { _id?: unknown; _source?: unknown; fields?: unknown }
    const out: Record<string, unknown> = { _id: hit._id ?? null }
    if (hit._source && typeof hit._source === 'object') Object.assign(out, flatten(hit._source))
    if (hit.fields && typeof hit.fields === 'object') Object.assign(out, flatten(hit.fields))
    return out
  })
  const keys: string[] = []
  for (const m of maps) for (const k of Object.keys(m)) if (!keys.includes(k) && keys.length < MAX_FIELDS + 1) keys.push(k)
  return {
    columns: keys.map((name) => ({ name })),
    rows: maps.map((m) => keys.map((k) => (k in m ? m[k] : null))),
  }
}

/** Nested objects become dotted paths up to depth 4; arrays and scalars are kept as values. */
function flatten(obj: unknown, out: Record<string, unknown> = {}, prefix = '', depth = 0): Record<string, unknown> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    if (prefix) out[prefix] = obj
    return out
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 4) flatten(v, out, key, depth + 1)
    else out[key] = v
  }
  return out
}

/* ------------------------------------------------------------------ transport */

interface Call { status: number; json: unknown; text: string }

export class ElasticTransport implements Transport {
  private abort?: AbortController

  constructor(private cfg: ConnectionConfig) {}

  /** A full connection string wins over host/port (and lets the SSH tunnel rewrite it). */
  private base(): string {
    const uri = this.cfg.uri?.trim()
    if (uri) return uri.replace(/\/+$/, '')
    const host = this.cfg.host?.trim() || '127.0.0.1'
    const port = this.cfg.port && this.cfg.port > 0 ? this.cfg.port : DEFAULT_PORT
    return `${this.cfg.ssl ? 'https' : 'http'}://${host}:${port}`
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' }
    const user = this.cfg.user?.trim()
    if (user || this.cfg.password) headers.Authorization = `Basic ${Buffer.from(`${user ?? ''}:${this.cfg.password ?? ''}`).toString('base64')}`
    return headers
  }

  async open(): Promise<{ version?: string }> {
    let json: unknown
    try { json = (await this.call('GET', '/')).json } catch (e) {
      throw new Error(`Elasticsearch connection to ${this.base()} failed: ${msg(e)}`)
    }
    return { version: (json as { version?: { number?: string } })?.version?.number }
  }

  async query(sql: string): Promise<RawResult> {
    const req = parseElasticRequest(sql)
    if (!req) throw new Error('Not an Elasticsearch request: start with `GET /_cat/indices` or `POST /index/_search`.')
    if (req.internal) {
      const [index, offset, count] = req.args
      if (!index) throw new Error('SEARCH needs an index name.')
      return this.search(index, Number.parseInt(offset ?? '0', 10) || 0, Number.parseInt(count ?? '500', 10) || 500)
    }
    if (!isElasticRead(sql)) throw new Error(`Request ${req.method} ${req.path} is not allowed: this Elasticsearch console is read-only.`)
    // Kibana's Dev Tools allows `GET /index/_search` with a JSON body, but fetch() cannot send one.
    // Elasticsearch treats POST as the same read request on these endpoints; anywhere else a body
    // behind GET is refused instead of silently becoming a write.
    let method = req.method
    if (method === 'GET' && req.body) {
      if (!isElasticReadPost(req.path)) throw new Error(`Only read endpoints accept a GET with a JSON body (searches, counts, analysis): ${req.path}`)
      method = 'POST'
    }
    const r = await this.call(method, req.path, req.body)
    if (r.status >= 400) throw new Error(describeError(r))
    return replyToResult(r.json)
  }

  /** fetch is abortable, so cancel() stops an in-flight request instead of waiting it out. */
  async cancel(): Promise<void> { this.abort?.abort() }

  /** No persistent connection of our own: HTTP keep-alive sockets belong to the process pool. */
  async close(): Promise<void> { /* no-op */ }

  /* -------------------------------------------------- paged search reader (SEARCH) */

  private async search(index: string, offset: number, count: number): Promise<RawResult> {
    const from = Math.max(0, offset)
    const size = Math.max(1, Math.min(count, MAX_ROWS))
    // `sort: _doc` keeps from/size windows stable and cheap; the total hit count is uninteresting here.
    const body = JSON.stringify({ from, size, sort: ['_doc'], track_total_hits: false })
    const r = await this.call('POST', `/${encodeURIComponent(index)}/_search`, body)
    if (r.status >= 400) throw new Error(describeError(r))
    return hitsToResult(r.json)
  }

  /* -------------------------------------------------- explorer model */

  /** One `indices` schema; each index is a table whose columns come from its mapping. */
  async introspectModel(): Promise<{ schemas: SchemaInfo[] }> {
    const r = await this.call('GET', '/_cat/indices?format=json&h=index&s=index')
    if (r.status >= 400) throw new Error(describeError(r))
    const list = Array.isArray(r.json) ? (r.json as { index?: unknown }[]) : []
    const names = list.map((row) => String(row.index ?? '')).filter(Boolean).slice(0, MAX_INDICES)
    const deadline = Date.now() + TIME_BUDGET_MS
    const tables: TableInfo[] = []
    for (const name of names) {
      let columns: ColumnInfo[] = []
      // Mappings are one request per index: fetch the first ones, then list the rest without columns.
      if (tables.length < MAX_MAPPING_INDICES && Date.now() < deadline) columns = await this.mappingColumns(name).catch(() => [])
      tables.push({ name, kind: 'table', columns, foreignKeys: [], indexes: [] })
    }
    return { schemas: [{ name: 'indices', tables }] }
  }

  /** `GET /<index>/_mapping` → flattened field paths (multi-field subfields included) as columns. */
  private async mappingColumns(index: string): Promise<ColumnInfo[]> {
    const r = await this.call('GET', `/${encodeURIComponent(index)}/_mapping`)
    if (r.status >= 400) return []
    const properties = (r.json as Record<string, { mappings?: { properties?: unknown } }>)?.[index]?.mappings?.properties
    if (!properties || typeof properties !== 'object') return []
    const out: ColumnInfo[] = []
    const walk = (prefix: string, fields: Record<string, unknown>, depth: number) => {
      for (const [name, raw] of Object.entries(fields)) {
        if (out.length >= MAX_FIELDS) return
        const field = (raw ?? {}) as { type?: unknown; properties?: unknown; fields?: unknown }
        const path = prefix ? `${prefix}.${name}` : name
        const type = typeof field.type === 'string' ? field.type : field.properties ? 'object' : 'unknown'
        out.push({ name: path, dataType: type, nullable: true, isPrimaryKey: false, ordinal: out.length })
        if (field.fields && typeof field.fields === 'object') {
          for (const [subName, sub] of Object.entries(field.fields as Record<string, unknown>)) {
            if (out.length >= MAX_FIELDS) break
            const subType = (sub as { type?: unknown })?.type
            out.push({ name: `${path}.${subName}`, dataType: typeof subType === 'string' ? subType : 'unknown', nullable: true, isPrimaryKey: false, ordinal: out.length })
          }
        }
        if (field.properties && typeof field.properties === 'object' && depth < 4) walk(path, field.properties as Record<string, unknown>, depth + 1)
      }
    }
    walk('', properties as Record<string, unknown>, 0)
    return out
  }

  /* -------------------------------------------------- HTTP */

  private async call(method: string, path: string, body?: string): Promise<Call> {
    const ctrl = new AbortController()
    this.abort = ctrl
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(`${this.base()}${path}`, { method, headers: this.headers(), body: body || undefined, signal: ctrl.signal })
      const text = await res.text()
      let json: unknown
      try { json = text ? JSON.parse(text) : undefined } catch { json = undefined }
      return { status: res.status, json, text }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw new Error(`Elasticsearch request aborted (cancelled or over ${REQUEST_TIMEOUT_MS / 1000}s): ${method} ${path}`)
      throw new Error(`Elasticsearch request failed: ${msg(e)}`)
    } finally {
      clearTimeout(timer)
      if (this.abort === ctrl) this.abort = undefined
    }
  }
}

/* ------------------------------------------------------------------ errors */

/** Server error bodies (`{"error": {...}}`) become one readable line. */
function describeError(r: Call): string {
  const err = (r.json as { error?: unknown })?.error
  if (typeof err === 'string') return `Elasticsearch error (${r.status}): ${err}`
  if (err && typeof err === 'object') {
    const e = err as { reason?: unknown; type?: unknown; root_cause?: { reason?: unknown }[] }
    const reason = (typeof e.reason === 'string' && e.reason) || (typeof e.root_cause?.[0]?.reason === 'string' && e.root_cause[0].reason) || (typeof e.type === 'string' && e.type) || 'unknown error'
    return `Elasticsearch error (${r.status}): ${reason}`
  }
  return `Elasticsearch error (${r.status}): ${r.text.slice(0, 200) || 'empty response'}`
}

function msg(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause
    return cause instanceof Error ? `${e.message} (${cause.message})` : e.message
  }
  return String(e)
}
