import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSession } from '../src/main/db/factory'
import type { DbSession } from '../src/main/db/session'
import type { ConnectionConfig } from '../src/shared/types'

/**
 * Live RabbitMQ checks — skipped unless the Management API URL is provided:
 *
 *   STRATUM_TEST_RABBITMQ_URL=http://127.0.0.1:15672   required (management plugin, not AMQP)
 *   STRATUM_TEST_RABBITMQ_USER / _PASSWORD             optional (guest/guest often works locally)
 *   STRATUM_TEST_RABBITMQ_VHOST=/                      optional; defaults to /
 *   STRATUM_TEST_RABBITMQ_QUEUE=orders                 optional; defaults to the first queue
 *
 * The suite only lists queues and peeks with `ackmode=ack_requeue_true`; it never acknowledges,
 * publishes, purges or deletes, so it is safe on shared brokers (redelivery flags may change).
 */
const endpoint = process.env.STRATUM_TEST_RABBITMQ_URL
const suite = endpoint ? describe : describe.skip

const url = endpoint ? new URL(endpoint) : undefined
const cfg: ConnectionConfig = {
  id: 'rabbit-live',
  name: 'rabbit-live',
  kind: 'rabbitmq',
  host: url?.hostname,
  port: url?.port ? Number(url.port) : 15672,
  ssl: url?.protocol === 'https:',
  user: process.env.STRATUM_TEST_RABBITMQ_USER,
  password: process.env.STRATUM_TEST_RABBITMQ_PASSWORD,
}

const vhost = process.env.STRATUM_TEST_RABBITMQ_VHOST ?? '/'

suite('RabbitMQ live', () => {
  let s: DbSession
  let queue = process.env.STRATUM_TEST_RABBITMQ_QUEUE ?? ''

  beforeAll(async () => {
    s = createSession(cfg)
    await s.open()
  })

  afterAll(async () => { await s?.close().catch(() => undefined) })

  it('connects to the management API and reports a version', () => {
    expect(s.version).toBeTruthy()
  })

  it('lists queues by vhost', async () => {
    const m = await s.introspect()
    expect(m.kind).toBe('rabbitmq')
    const vhosts = m.schemas.map((x) => x.name)
    if (vhosts.length) expect(vhosts).toContain(vhost)
    if (!queue) queue = m.schemas.find((x) => x.name === vhost)?.tables[0]?.name ?? ''
  })

  it('peeks at a bounded window without acknowledging', async () => {
    if (!queue) return // no queues on this broker
    const r = await s.execute(`PEEK ${JSON.stringify(vhost)} ${JSON.stringify(queue)}`, { limit: 5 })
    expect(r.error).toBeUndefined()
    expect(r.columns.map((c) => c.name)).toEqual(['exchange', 'routingKey', 'redelivered', 'payload', 'properties', 'headers'])
    expect(r.rows.length).toBeLessThanOrEqual(5)
  })

  it('has no console: other statements are refused locally', async () => {
    for (const stmt of ['GET /api/queues', 'DELETE /api/queues/%2F/orders', 'PURGE orders']) {
      const r = await s.execute(stmt)
      expect(r.error, stmt).toMatch(/RabbitMQ has no query console/)
    }
  })
})
