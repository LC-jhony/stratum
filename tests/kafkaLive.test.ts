import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSession } from '../src/main/db/factory'
import type { DbSession } from '../src/main/db/session'
import type { ConnectionConfig } from '../src/shared/types'

/**
 * Live Kafka checks — skipped unless a broker is provided:
 *
 *   STRATUM_TEST_KAFKA_BROKERS=127.0.0.1:9092     required; comma-separated bootstrap brokers
 *   STRATUM_TEST_KAFKA_TOPIC=events                optional; defaults to the first user topic found
 *   STRATUM_TEST_KAFKA_SSL=1                       optional TLS
 *   STRATUM_TEST_KAFKA_USER / _PASSWORD            optional SASL/PLAIN credentials
 *
 * The suite connects with an admin client, lists topics, peeks at one bounded window with
 * auto-commit disabled, and checks that the console is refused. It never produces or commits.
 */
const brokers = process.env.STRATUM_TEST_KAFKA_BROKERS
const suite = brokers ? describe : describe.skip

const cfg: ConnectionConfig = {
  id: 'kafka-live',
  name: 'kafka-live',
  kind: 'kafka',
  host: brokers,
  user: process.env.STRATUM_TEST_KAFKA_USER,
  password: process.env.STRATUM_TEST_KAFKA_PASSWORD,
  ssl: process.env.STRATUM_TEST_KAFKA_SSL === '1',
}

suite('Kafka live', () => {
  let s: DbSession
  let topic = process.env.STRATUM_TEST_KAFKA_TOPIC ?? ''

  beforeAll(async () => {
    s = createSession(cfg)
    await s.open()
  })

  afterAll(async () => { await s?.close().catch(() => undefined) })

  it('lists user topics', async () => {
    const m = await s.introspect()
    expect(m.kind).toBe('kafka')
    expect(m.schemas.map((x) => x.name)).toEqual(['topics'])
    const names = m.schemas[0].tables.map((t) => t.name)
    expect(names.every((name) => !name.startsWith('__'))).toBe(true)
    if (!topic) topic = names[0] ?? ''
  })

  it('peeks at a bounded window read-only', async () => {
    if (!topic) return // a broker with no topics has nothing to peek at
    const r = await s.execute(`CONSUME ${JSON.stringify(topic)}`, { limit: 5 })
    expect(r.error).toBeUndefined()
    expect(r.columns.map((c) => c.name)).toEqual(['partition', 'offset', 'timestamp', 'key', 'value', 'headers'])
    expect(r.rows.length).toBeLessThanOrEqual(5)
    expect(r.rows.every((row) => Number.isInteger(row[1]) && typeof row[0] === 'number')).toBe(true)
  })

  it('has no console: other statements are refused locally', async () => {
    for (const stmt of ['SELECT * FROM x', 'PRODUCE events', 'DELETE topic x']) {
      const r = await s.execute(stmt)
      expect(r.error, stmt).toMatch(/Kafka has no query console/)
    }
  })
})
