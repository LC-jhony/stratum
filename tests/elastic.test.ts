import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hitsToResult, replyToResult } from '../src/main/db/transports/elastic'
import { createSession, } from '../src/main/db/factory'
import type { DbSession } from '../src/main/db/session'
import type { JdbcSidecar } from '../src/main/services/jdbcSidecar'
import { elasticStatementAt, isElasticRead, paginateElasticStatement, parseElasticRequest, splitElasticStatements } from '../src/shared/elastic'
import { KINDS, isSqlKind } from '../src/shared/kinds'
import type { ConnectionConfig } from '../src/shared/types'

/**
 * The Elasticsearch console is only as safe as this allowlist and only as useful as these reply
 * mappings, so both are pinned here against a minimal fake cluster that speaks the handful of REST
 * endpoints the transport uses. No network leaves the process.
 */

describe('elasticsearch statements', () => {
  it('splits requests at method lines and keeps JSON bodies whole', () => {
    const text = ['GET /_cat/indices?format=json', '', 'POST /users/_search', '{', '  "query": { "match_all": {} }', '}', ''].join('\n')
    const parts = splitElasticStatements(text)
    expect(parts.map((s) => s.text)).toEqual([
      'GET /_cat/indices?format=json',
      'POST /users/_search\n{\n  "query": { "match_all": {} }\n}',
    ])
  })

  it('finds the statement under the caret, including inside the body', () => {
    const text = 'GET /_cat/indices\nPOST /users/_search\n{\n  "size": 1\n}\n'
    expect(elasticStatementAt(text, text.indexOf('_cat'))?.text).toBe('GET /_cat/indices')
    expect(elasticStatementAt(text, text.indexOf('"size"'))?.text).toContain('POST /users/_search')
  })

  it('parses method, path and body; rejects absolute URLs', () => {
    expect(parseElasticRequest('GET /_cluster/health')).toMatchObject({ method: 'GET', path: '/_cluster/health', args: [] })
    expect(parseElasticRequest('post /users/_search\n{"size": 2}')).toMatchObject({ method: 'POST', path: '/users/_search', body: '{"size": 2}' })
    expect(parseElasticRequest('POST /users/_search {"query":{}}')).toMatchObject({ body: '{"query":{}}' })
    expect(parseElasticRequest('GET http://evil.example/')).toBeUndefined()
    expect(parseElasticRequest('not a request')).toBeUndefined()
    expect(parseElasticRequest('SEARCH "my index" 10 20')).toMatchObject({ internal: true, args: ['my index', '10', '20'] })
  })
})

describe('read-only allowlist', () => {
  it('accepts reads: GET/HEAD anywhere and POST on read endpoints', () => {
    for (const s of ['GET /_cat/indices?format=json', 'HEAD /users', 'GET /users/_doc/1', 'POST /users/_search', 'POST /_msearch',
      'POST /users/_count', 'POST /users/_field_caps?fields=age', 'POST /users/_search/template', 'GET /_cluster/health', 'SEARCH "users" 0 500']) {
      expect(isElasticRead(s), s).toBe(true)
    }
  })

  it('rejects writes and cluster mutations', () => {
    for (const s of ['DELETE /users', 'PUT /users/_doc/1', 'POST /users/_doc', 'PATCH /users/_doc/1', 'POST /_bulk',
      'POST /users/_update/1', 'POST /users/_delete_by_query', 'POST /_reindex', 'POST /_scripts/my-script', 'POST /_snapshot/repo/snap']) {
      expect(isElasticRead(s), s).toBe(false)
    }
  })

  it('pages search requests and the SEARCH reader, and nothing else', () => {
    expect(paginateElasticStatement('SEARCH "users"', 501, 0)).toBe('SEARCH "users" 0 501')
    expect(paginateElasticStatement('GET /users/_search', 501, 1000)).toBe('GET /users/_search?from=1000&size=501')
    expect(paginateElasticStatement('GET /users/_search?q=name:ada', 501, 0)).toBe('GET /users/_search?q=name%3Aada&from=0&size=501')
    expect(paginateElasticStatement('POST /users/_search\n{"query":{}}', 501, 0)).toBe('POST /users/_search?from=0&size=501\n{"query":{}}')
    expect(paginateElasticStatement('GET /_cat/indices', 501, 0)).toBeUndefined()
    expect(paginateElasticStatement('GET /users/_mapping', 501, 0)).toBeUndefined()
  })
})

describe('replies as grid rows', () => {
  it('maps hits to _id plus flattened source fields', () => {
    const r = hitsToResult({ hits: { hits: [{ _id: 'u1', _source: { name: 'ada', address: { city: 'Madrid' } } }, { _id: 'u2', _source: { name: 'grace', age: 85 } }] } })
    expect(r.columns.map((c) => c.name)).toEqual(['_id', 'name', 'address.city', 'age'])
    expect(r.rows).toEqual([['u1', 'ada', 'Madrid', null], ['u2', 'grace', null, 85]])
  })

  it('maps arrays of objects (_cat) and plain objects', () => {
    const cat = replyToResult([{ index: 'users', 'docs.count': '3' }, { index: 'events', health: 'green' }])
    expect(cat.columns.map((c) => c.name)).toEqual(['index', 'docs.count', 'health'])
    expect(cat.rows).toEqual([['users', '3', null], ['events', null, 'green']])
    const obj = replyToResult({ acknowledged: true, shards_acknowledged: false })
    expect(obj.columns.map((c) => c.name)).toEqual(['key', 'value'])
    expect(obj.rows).toEqual([['acknowledged', true], ['shards_acknowledged', false]])
    expect(replyToResult(7)).toEqual({ columns: [{ name: 'value' }], rows: [[7]] })
  })
})

/* ------------------------------------------------------------------ fake cluster */

interface Fake {
  base: string
  requests: { method: string; url: string; body: string }[]
  close(): Promise<void>
}

function startFakeElastic(): Promise<Fake> {
  const requests: Fake['requests'] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body })
      const path = (req.url ?? '').split('?')[0]
      const send = (code: number, json: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json', 'X-Elastic-Product': 'Elasticsearch' }); res.end(JSON.stringify(json)) }
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
      if (path === '/') return send(200, { name: 'fake', version: { number: '8.10.2' } })
      if (path === '/_cat/indices') return send(200, [{ index: 'users' }, { index: 'events' }])
      if (path === '/users/_mapping') return send(200, { users: { mappings: { properties: { name: { type: 'text', fields: { keyword: { type: 'keyword' } } }, age: { type: 'integer' }, address: { properties: { city: { type: 'keyword' } } } } } } })
      if (path === '/events/_mapping') return send(200, { events: { mappings: { properties: { id: { type: 'keyword' } } } } })
      if (path === '/users/_search') {
        const parsed = body ? (JSON.parse(body) as { from?: number; size?: number }) : {}
        const from = Number(query.get('from') ?? parsed.from ?? 0), size = Number(query.get('size') ?? parsed.size ?? 10)
        const all = Array.from({ length: 12 }, (_, i) => ({ _id: `u${i}`, _source: { name: `user ${i}`, age: i, address: { city: 'Madrid' } } }))
        return send(200, { hits: { total: { value: 12 }, hits: all.slice(from, from + size) } })
      }
      if (path === '/missing/_search') return send(404, { error: { type: 'index_not_found_exception', reason: 'no such index [missing]' }, status: 404 })
      send(200, {})
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as AddressInfo).port
    resolve({ base: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => { server.close(() => r()) }) })
  }))
}

describe('elasticsearch transport against a fake cluster', () => {
  let fake: Fake
  let s: DbSession

  const cfg = (extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({ id: 'es', name: 'es', kind: 'elastic', uri: `${fake.base}`, ...extra })

  beforeAll(async () => {
    fake = await startFakeElastic()
    s = createSession(cfg(), {} as JdbcSidecar)
    await s.open()
  })

  afterAll(async () => { await s?.close().catch(() => undefined); await fake?.close() })

  it('reports the cluster version on connect', () => {
    expect(s.version).toBe('8.10.2')
  })

  it('introspects indices as tables and mappings as columns', async () => {
    const m = await s.introspect()
    expect(m.kind).toBe('elastic')
    expect(isSqlKind('elastic')).toBe(false)
    expect(KINDS.elastic.defaultPort).toBe(9200)
    expect(m.schemas.map((x) => x.name)).toEqual(['indices'])
    expect(m.schemas[0].tables.map((t) => t.name)).toEqual(['users', 'events'])
    expect(m.schemas[0].tables[0].columns.map((c) => `${c.name}:${c.dataType}`)).toEqual(['name:text', 'name.keyword:keyword', 'age:integer', 'address:object', 'address.city:keyword'])
  })

  it('runs Dev Tools reads and maps the replies', async () => {
    const cat = await s.execute('GET /_cat/indices?format=json')
    expect(cat.error).toBeUndefined()
    expect(cat.columns.map((c) => c.name)).toEqual(['index'])
    expect(cat.rows).toEqual([['users'], ['events']])

    const search = await s.execute('GET /users/_search')
    expect(search.columns.map((c) => c.name)).toEqual(['_id', 'name', 'age', 'address.city'])
    expect(search.rows).toHaveLength(12)
    expect(search.rows[0]).toEqual(['u0', 'user 0', 0, 'Madrid'])
    expect(fake.requests.at(-1)!.url).toContain('from=0&size=501')
  })

  it('sends a GET with a JSON body as POST on read endpoints, and refuses it elsewhere', async () => {
    const search = await s.execute('GET /users/_search\n{"query": {"match_all": {}}}')
    expect(search.error).toBeUndefined()
    expect(fake.requests.at(-1)).toMatchObject({ method: 'POST', url: '/users/_search?from=0&size=501' })
    expect(fake.requests.at(-1)!.body).toContain('"match_all"')

    const before = fake.requests.length
    const sneaky = await s.execute('GET /users/_doc\n{"field": 1}')
    expect(sneaky.error).toMatch(/Only read endpoints accept a GET with a JSON body/)
    expect(fake.requests.length).toBe(before)
  })

  it('pages the grid reader through SEARCH', async () => {
    const first = await s.execute('SEARCH "users"', { limit: 5 })
    expect(first.rows).toHaveLength(5)
    expect(first.hasMore).toBe(true)
    expect(JSON.parse(fake.requests.at(-1)!.body)).toMatchObject({ from: 0, size: 6 })
    const last = await s.execute('SEARCH "users"', { limit: 5, offset: 10 })
    expect(last.rows).toHaveLength(2)
    expect(last.hasMore).toBe(false)
    expect(JSON.parse(fake.requests.at(-1)!.body)).toMatchObject({ from: 10, size: 6 })
  })

  it('rejects writes before they reach the cluster', async () => {
    const before = fake.requests.length
    for (const stmt of ['DELETE /users', 'PUT /users/_doc/1', 'POST /users/_doc', 'POST /_bulk', 'PATCH /users/_doc/1']) {
      const r = await s.execute(stmt)
      expect(r.error, stmt).toMatch(/read-only/)
    }
    expect(fake.requests.length).toBe(before)
  })

  it('maps server errors into the results pane', async () => {
    const r = await s.execute('SEARCH "missing"')
    expect(r.error).toMatch(/no such index \[missing\]/)
  })

  it('keeps reads working on read-only sources and gates the rest', async () => {
    const ro = createSession(cfg({ id: 'es-ro', readonly: true }), {} as JdbcSidecar)
    await ro.open()
    expect((await ro.execute('GET /users/_search')).error).toBeUndefined()
    expect((await ro.execute('DELETE /users')).error).toMatch(/Data source is read-only/)
    await ro.close()
  })
})
