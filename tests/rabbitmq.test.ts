import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSession } from '../src/main/db/factory'
import { createRabbitDialect } from '../src/main/db/rabbitmqDialect'
import { DbSession } from '../src/main/db/session'
import {
  RabbitMqTransport,
  isRabbitRead,
  paginateRabbitStatement,
  parseRabbitPeek,
} from '../src/main/db/transports/rabbitmq'
import { KINDS, isSqlKind } from '../src/shared/kinds'
import type { JdbcSidecar } from '../src/main/services/jdbcSidecar'
import type { ConnectionConfig } from '../src/shared/types'

/**
 * RabbitMQ has no console, so the pins are the internal `PEEK` reader, vhost/queue introspection,
 * the exact Management API calls (basic auth, `ack_requeue_true`, base64 payloads) and the local
 * window slicing that stands in for the API's missing offset. A real HTTP server keeps fetch,
 * status handling and JSON bodies in the loop without a broker.
 */

const USER = 'ana'
const PASS = 'secret'
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`

const text = (payload: string, extra: Record<string, unknown> = {}) => ({
  payload: Buffer.from(payload).toString('base64'),
  payload_bytes: Buffer.byteLength(payload),
  redelivered: false,
  exchange: 'events',
  routing_key: 'orders.created',
  properties: { content_type: 'application/json' },
  headers: { trace: 'a' },
  ...extra,
})

const ORDERS = [
  text('{"id":1}'),
  {
    payload: Buffer.from([0xff, 0xfe]).toString('base64'),
    payload_bytes: 2,
    redelivered: true,
    exchange: '',
    routing_key: 'orders',
    properties: {},
    headers: {},
  },
  { ...text('abcdef'), payload_bytes: 50000 }, // server truncated the original
  text('last'),
]

interface Fake {
  base: string
  requests: { method: string; url: string; body: string; auth?: string }[]
  close(): Promise<void>
}

function startFakeRabbit(): Promise<Fake> {
  const requests: Fake['requests'] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const url = req.url ?? ''
      const path = url.split('?')[0]
      requests.push({ method: req.method ?? '', url, body, auth: req.headers.authorization })
      const send = (code: number, json?: unknown) => {
        if (json === undefined) { res.writeHead(code); res.end(); return }
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(json))
      }
      if (req.headers.authorization !== AUTH) return send(401)
      if (path === '/api/overview') return send(200, { rabbitmq_version: '4.1.2', cluster_name: 'rabbit@fake' })
      if (path === '/api/queues') {
        return send(200, {
          items: [
            { name: 'orders', vhost: '/', messages: 4 },
            { name: 'payments', vhost: '/', messages: 1 },
            { name: 'orders', vhost: 'staging', messages: 1 },
          ],
          page: 1,
          page_size: 500,
          total_count: 3,
        })
      }
      const segments = path.split('/')
      if (segments[1] === 'api' && segments[2] === 'queues' && segments[5] === 'get') {
        const vhost = decodeURIComponent(segments[3])
        const queue = decodeURIComponent(segments[4])
        const known = (vhost === '/' && queue === 'orders') || (vhost === '/' && queue === 'payments') || (vhost === 'staging' && queue === 'orders')
        if (!known) return send(404, { error: 'Object Not Found', reason: 'Not Found' })
        if (req.method !== 'POST') return send(405, { error: 'Method Not Allowed' })
        const parsed = body ? (JSON.parse(body) as { count?: number }) : {}
        const messages = vhost === '/' && queue === 'orders' ? ORDERS : vhost === '/'
          ? [text('payment', { exchange: 'payments', routing_key: 'paid' })]
          : [text('staged', { exchange: 'staging', routing_key: 'orders' })]
        return send(200, messages.slice(0, Number(parsed.count ?? 1)))
      }
      send(404, { error: 'Object Not Found', reason: 'Not Found' })
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as AddressInfo).port
    resolve({ base: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => { server.close(() => r()) }) })
  }))
}

const cfg = (port: number, extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: 'rabbit', name: 'rabbit', kind: 'rabbitmq', host: '127.0.0.1', port, user: USER, password: PASS, ...extra,
})

const make = (port: number, extra: Partial<ConnectionConfig> = {}) => {
  const transport = new RabbitMqTransport(cfg(port, extra))
  return { transport, session: new DbSession(cfg(port, extra), transport, createRabbitDialect(transport)) }
}

describe('rabbitmq statements', () => {
  it('parses quoted and bare PEEK statements and rewrites them for paging', () => {
    expect(parseRabbitPeek('PEEK "/" "orders"')).toEqual({ vhost: '/', queue: 'orders', offset: 0, limit: 500 })
    expect(parseRabbitPeek('peek staging orders 10 5')).toEqual({ vhost: 'staging', queue: 'orders', offset: 10, limit: 5 })
    expect(parseRabbitPeek('PEEK "a b" "q\\"x" 0 2')).toEqual({ vhost: 'a b', queue: 'q"x', offset: 0, limit: 2 })
    expect(paginateRabbitStatement('PEEK "/" "orders"', 501, 1000)).toBe('PEEK "/" "orders" 1000 501')
    expect(paginateRabbitStatement('GET /api/queues', 501, 0)).toBeUndefined()
    expect(isRabbitRead('PEEK "/" "orders"')).toBe(true)
    expect(isRabbitRead('GET /api/queues')).toBe(false)
  })
})

describe('rabbitmq transport against a fake management API', () => {
  let fake: Fake
  let session: DbSession
  let transport: RabbitMqTransport

  beforeAll(async () => {
    fake = await startFakeRabbit()
    const port = Number(new URL(fake.base).port)
    const made = make(port)
    transport = made.transport
    session = made.session
    await session.open()
  })

  afterAll(async () => { await session?.close().catch(() => undefined); await fake?.close() })

  it('reports the management version on connect with basic auth', () => {
    expect(session.version).toBe('4.1.2')
    const overview = fake.requests.find((r) => r.url === '/api/overview')!
    expect(overview.auth).toBe(AUTH)
  })

  it('introspects vhosts as schemas and queues as tables', async () => {
    const m = await session.introspect()
    expect(m.kind).toBe('rabbitmq')
    expect(isSqlKind('rabbitmq')).toBe(false)
    expect(KINDS.rabbitmq.defaultPort).toBe(15672)
    expect(m.schemas.map((s) => s.name)).toEqual(['/', 'staging'])
    expect(m.schemas[0].tables.map((t) => t.name)).toEqual(['orders', 'payments'])
    expect(m.schemas[1].tables.map((t) => t.name)).toEqual(['orders'])
    expect(m.schemas[0].tables[0].columns.map((c) => c.name)).toEqual(['exchange', 'routingKey', 'redelivered', 'payload', 'properties', 'headers'])
    expect(fake.requests.some((r) => r.url === '/api/queues?page=1&page_size=500')).toBe(true)
  })

  it('peeks with ack_requeue_true and base64 payloads, decoding text, binary and truncation', async () => {
    const r = await session.execute('PEEK "/" "orders"', { limit: 10 })
    expect(r.error).toBeUndefined()
    expect(r.rows).toEqual([
      ['events', 'orders.created', false, '{"id":1}', '{"content_type":"application/json"}', '{"trace":"a"}'],
      ['', 'orders', true, '0xfffe', null, null],
      ['events', 'orders.created', false, 'abcdef…', '{"content_type":"application/json"}', '{"trace":"a"}'],
      ['events', 'orders.created', false, 'last', '{"content_type":"application/json"}', '{"trace":"a"}'],
    ])
    const get = fake.requests.filter((r) => r.url.endsWith('/get')).at(-1)!
    expect(get.method).toBe('POST')
    expect(get.url).toBe('/api/queues/%2F/orders/get')
    expect(JSON.parse(get.body)).toEqual({ count: 11, ackmode: 'ack_requeue_true', encoding: 'base64', truncate: 20000 })
  })

  it('slices the requested window locally because the API has no offset', async () => {
    const page = await session.execute('PEEK "/" "orders"', { limit: 2, offset: 1 })
    expect(page.rows.map((row) => [row[1], row[3]])).toEqual([['orders', '0xfffe'], ['orders.created', 'abcdef…']])
    expect(page.hasMore).toBe(true)
    const get = fake.requests.filter((r) => r.url.endsWith('/get')).at(-1)!
    expect(JSON.parse(get.body).count).toBe(4) // offset 1 + PAGE limit 3

    const tail = await session.execute('PEEK "/" "orders"', { limit: 5, offset: 3 })
    expect(tail.rows.map((row) => row[3])).toEqual(['last'])
    expect(tail.hasMore).toBe(false)

    const capped = await session.execute('PEEK "/" "orders"', { limit: 5, offset: 2000 })
    expect(capped.error).toMatch(/capped at 2000 messages/)
  })

  it('peeks at a named vhost', async () => {
    const r = await session.execute('PEEK "staging" "orders"', { limit: 5 })
    expect(r.error).toBeUndefined()
    expect(r.rows[0][3]).toBe('staged')
    expect(fake.requests.some((r) => r.url === '/api/queues/staging/orders/get')).toBe(true)
  })

  it('refuses every console statement before touching the API', async () => {
    const before = fake.requests.length
    for (const stmt of ['GET /api/queues', 'DELETE /api/queues/%2F/orders', 'PURGE orders', 'PEEK "/" "orders" extra junk']) {
      const r = await session.execute(stmt)
      expect(r.error, stmt).toMatch(/RabbitMQ has no query console/)
    }
    expect(fake.requests.length).toBe(before)
  })

  it('keeps peeking on read-only sources and gates the rest', async () => {
    const port = Number(new URL(fake.base).port)
    const { session: readOnly } = make(port, { readonly: true })
    await readOnly.open()
    expect((await readOnly.execute('PEEK "/" "orders"', { limit: 1 })).error).toBeUndefined()
    expect((await readOnly.execute('GET /api/queues')).error).toMatch(/Data source is read-only/)
    await readOnly.close()
  })

  it('maps 401s, 404s and aborted requests into the results pane', async () => {
    const port = Number(new URL(fake.base).port)
    const denied = make(port, { password: 'wrong' })
    await expect(denied.transport.open()).rejects.toThrow(/401/)

    expect((await session.execute('PEEK "/" "missing"')).error).toMatch(/Object Not Found/)
    await transport.close()
  })

  it('is registered in the factory with a generic dialect', () => {
    const s = createSession(cfg(15672), {} as JdbcSidecar)
    expect(s.dialect.id).toBe('generic')
    expect(s.config.kind).toBe('rabbitmq')
  })
})
