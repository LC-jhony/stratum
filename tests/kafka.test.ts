import { describe, expect, it } from 'vitest'
import { createSession } from '../src/main/db/factory'
import { createKafkaDialect } from '../src/main/db/kafkaDialect'
import { DbSession } from '../src/main/db/session'
import {
  KafkaTransport,
  brokersOf,
  isKafkaRead,
  paginateKafkaStatement,
  parseKafkaConsume,
  type KafkaAdminLike,
  type KafkaClientLike,
  type KafkaConsumerLike,
  type KafkaMessageLike,
} from '../src/main/db/transports/kafka'
import { KINDS, isSqlKind } from '../src/shared/kinds'
import type { ConnectionConfig } from '../src/shared/types'

/**
 * Kafka is an Explorer-only provider (no console). These pins cover the internal `CONSUME` reader,
 * broker list parsing, topic introspection (internal topics hidden), message decoding and headers,
 * offset windows, the drained/budget stop paths and the read-only gate — all through a fake client
 * that mimics kafkajs' run-until-stopped consumer.
 */

const cfg = (extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({ id: 'kafka', name: 'kafka', kind: 'kafka', host: '127.0.0.1', ...extra })
const iso = (ms: number) => new Date(ms).toISOString()
const base = 1_700_000_000_000

const message = (partition: number, offset: number, extra: Partial<KafkaMessageLike> = {}): KafkaMessageLike => ({
  partition,
  offset: String(offset),
  timestamp: String(base + (partition * 6 + offset) * 1000),
  key: Buffer.from(`k${offset}`),
  value: Buffer.from(JSON.stringify({ n: offset })),
  ...extra,
})

const events: KafkaMessageLike[] = []
for (let offset = 0; offset < 6; offset++) events.push(message(0, offset))
for (let offset = 0; offset < 6; offset++) events.push(message(1, offset))
events[0] = { ...events[0], headers: { trace: Buffer.from('abc'), multi: [Buffer.from('a'), Buffer.from('b')] } }
events[1] = { ...events[1], key: null, value: Buffer.from([0xff, 0xfe]) }
events[2] = { ...events[2], value: null }
/** One message past MAX_WALK, enough to pin the paging cap without building a real topic. */
const huge = Array.from({ length: 5001 }, (_, offset) => message(0, offset))

class FakeAdmin implements KafkaAdminLike {
  connects = 0
  disconnects = 0

  constructor(private broker: FakeKafka) {}

  async connect(): Promise<void> {
    this.connects++
    if (this.broker.failConnect) throw new Error('ECONNREFUSED')
  }

  async disconnect(): Promise<void> { this.disconnects++ }

  async listTopics(): Promise<string[]> {
    if (this.broker.failTopics) throw new Error('Topic authorization failed')
    return this.broker.topics
  }

  async fetchTopicOffsets(topic: string): Promise<{ partition: number; low: string; high: string }[]> {
    const messages = this.broker.messages[topic]
    if (!messages) throw new Error('UnknownTopicOrPartition')
    const partitions = [...new Set(messages.map((m) => m.partition))].sort((a, b) => a - b)
    return partitions.map((partition) => {
      const offsets = messages.filter((m) => m.partition === partition).map((m) => Number(m.offset))
      return offsets.length
        ? { partition, low: String(Math.min(...offsets)), high: String(Math.max(...offsets) + 1) }
        : { partition, low: '0', high: '0' }
    })
  }
}

class FakeConsumer implements KafkaConsumerLike {
  topic = ''
  stopped = false
  runConfig?: Parameters<KafkaConsumerLike['run']>[0]
  fromBeginning?: boolean
  private resolveRun?: () => void

  constructor(private broker: FakeKafka, readonly groupId: string) {}

  async connect(): Promise<void> {
    if (this.broker.failConsume) throw new Error('Broker not available')
  }

  async subscribe({ topic, fromBeginning }: { topic: string; fromBeginning?: boolean }): Promise<void> {
    this.topic = topic
    this.fromBeginning = fromBeginning
  }

  run(config: Parameters<KafkaConsumerLike['run']>[0]): Promise<void> {
    this.runConfig = config
    setTimeout(() => void this.deliver(), 0)
    return new Promise<void>((resolve) => { this.resolveRun = resolve })
  }

  private async deliver(): Promise<void> {
    for (const message of this.broker.messages[this.topic] ?? []) {
      if (this.stopped) return
      await this.runConfig!.eachMessage({ topic: this.topic, partition: message.partition, message })
      if (this.stopped) return
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.resolveRun?.()
  }

  async disconnect(): Promise<void> {
    this.stopped = true
    this.resolveRun?.()
  }
}

class FakeKafka implements KafkaClientLike {
  readonly topics = ['events', 'logs', 'empty', 'huge', '__consumer_offsets']
  readonly messages: Record<string, KafkaMessageLike[]> = { events, logs: [message(0, 0)], empty: [], huge }
  failConnect = false
  failTopics = false
  failConsume = false
  readonly adminClient = new FakeAdmin(this)
  readonly consumers: FakeConsumer[] = []

  admin(): KafkaAdminLike { return this.adminClient }

  consumer({ groupId }: { groupId: string }): KafkaConsumerLike {
    const consumer = new FakeConsumer(this, groupId)
    this.consumers.push(consumer)
    return consumer
  }
}

const make = (extra: Partial<ConnectionConfig> = {}) => {
  const fake = new FakeKafka()
  const transport = new KafkaTransport(cfg(extra), () => fake)
  return { fake, transport, session: new DbSession(cfg(extra), transport, createKafkaDialect(transport)) }
}

describe('kafka statements', () => {
  it('parses CONSUME and rewrites it for paging', () => {
    expect(parseKafkaConsume('CONSUME "events"')).toEqual({ topic: 'events', offset: 0, limit: 500 })
    expect(parseKafkaConsume('consume events 10 5')).toEqual({ topic: 'events', offset: 10, limit: 5 })
    expect(parseKafkaConsume('CONSUME "a\\"b" 0 2')).toEqual({ topic: 'a"b', offset: 0, limit: 2 })
    expect(paginateKafkaStatement('CONSUME "events"', 501, 1000)).toBe('CONSUME "events" 1000 501')
    expect(paginateKafkaStatement('SELECT 1', 501, 0)).toBeUndefined()
    expect(isKafkaRead('CONSUME "events"')).toBe(true)
    expect(isKafkaRead('PRODUCE events')).toBe(false)
  })

  it('completes bare broker names with the configured port', () => {
    expect(brokersOf(cfg({ host: 'a, b:19092' }))).toEqual(['a:9092', 'b:19092'])
    expect(brokersOf(cfg({ host: 'a', port: 19092 }))).toEqual(['a:19092'])
    expect(brokersOf(cfg({ host: undefined }))).toEqual(['localhost:9092'])
  })
})

describe('kafka transport', () => {
  it('connects the admin, validates topic listing and reports the target', async () => {
    const { transport, fake } = make()
    expect(await transport.open()).toEqual({})
    expect(fake.adminClient.connects).toBe(1)

    const denied = make()
    denied.fake.failTopics = true
    await expect(denied.transport.open()).rejects.toThrow(/Kafka connection to 127\.0\.0\.1:9092 failed: Topic authorization failed/)

    const broken = make()
    broken.fake.failConnect = true
    await expect(broken.transport.open()).rejects.toThrow(/Kafka connection to 127\.0\.0\.1:9092 failed: ECONNREFUSED/)
  })

  it('introspects user topics as tables under one topics schema', async () => {
    const { session } = make()
    await session.open()
    const m = await session.introspect()
    expect(m.kind).toBe('kafka')
    expect(isSqlKind('kafka')).toBe(false)
    expect(KINDS.kafka.defaultPort).toBe(9092)
    expect(m.schemas.map((s) => s.name)).toEqual(['topics'])
    expect(m.schemas[0].tables.map((t) => t.name)).toEqual(['empty', 'events', 'huge', 'logs'])
    expect(m.schemas[0].tables[0].columns.map((c) => c.name)).toEqual(['partition', 'offset', 'timestamp', 'key', 'value', 'headers'])
    expect(m.schemas[0].tables[0].columns.find((c) => c.name === 'offset')!.dataType).toBe('int64')
  })

  it('peeks at the first page, decoding text, binary, nulls and headers', async () => {
    const { session, fake } = make()
    await session.open()
    const r = await session.execute('CONSUME "events"', { limit: 5 })
    expect(r.error).toBeUndefined()
    expect(r.hasMore).toBe(true)
    expect(r.rows).toEqual([
      [0, 0, iso(base), 'k0', '{"n":0}', '{"trace":"abc","multi":["a","b"]}'],
      [0, 1, iso(base + 1000), null, '0xfffe', null],
      [0, 2, iso(base + 2000), 'k2', null, null],
      [0, 3, iso(base + 3000), 'k3', '{"n":3}', null],
      [0, 4, iso(base + 4000), 'k4', '{"n":4}', null],
    ])
    const consumer = fake.consumers[0]
    expect(consumer.fromBeginning).toBe(true)
    expect(consumer.groupId).toMatch(/^stratum-peek-/)
    expect(consumer.runConfig?.autoCommit).toBe(false)
  })

  it('skips to the requested offset and stops when the topic is drained', async () => {
    const { session } = make()
    await session.open()
    const deep = await session.execute('CONSUME "events"', { limit: 2, offset: 10 })
    expect(deep.error).toBeUndefined()
    expect(deep.rows.map((row) => [row[0], row[1]])).toEqual([[1, 4], [1, 5]])
    expect(deep.hasMore).toBe(false)
  })

  it('returns an empty page for empty topics and offsets past the end without a consumer', async () => {
    const { session, fake } = make()
    await session.open()
    const empty = await session.execute('CONSUME "empty"', { limit: 5 })
    expect(empty.rows).toEqual([])
    const beyond = await session.execute('CONSUME "events"', { limit: 5, offset: 50 })
    expect(beyond.rows).toEqual([])
    expect(fake.consumers).toHaveLength(0)
  })

  it('refuses a page that starts beyond the walk cap without starting a consumer', async () => {
    const { session, fake } = make()
    await session.open()
    const capped = await session.execute('CONSUME "huge"', { limit: 5, offset: 5000 })
    expect(capped.error).toMatch(/capped at 5000 messages/)
    expect(fake.consumers).toHaveLength(0)
  })

  it('refuses every console statement before touching a consumer', async () => {
    const { session, fake } = make()
    await session.open()
    for (const stmt of ['SELECT * FROM events', 'PRODUCE events', 'DELETE topic events', 'CONSUME "events" extra junk']) {
      const r = await session.execute(stmt)
      expect(r.error, stmt).toMatch(/Kafka has no query console/)
    }
    expect(fake.consumers).toHaveLength(0)
  })

  it('keeps paging working on read-only sources and gates the rest', async () => {
    const { session } = make({ readonly: true })
    await session.open()
    expect((await session.execute('CONSUME "events"', { limit: 2 })).error).toBeUndefined()
    expect((await session.execute('PRODUCE events')).error).toMatch(/Data source is read-only/)
  })

  it('maps admin, topic and consumer errors into the results pane', async () => {
    const { session, fake } = make()
    await session.open()
    expect((await session.execute('CONSUME "missing"')).error).toMatch(/UnknownTopicOrPartition/)

    fake.failConsume = true
    expect((await session.execute('CONSUME "events"')).error).toMatch(/Broker not available/)
  })

  it('closes the admin and is registered with a generic dialect', async () => {
    const { transport, session, fake } = make()
    await session.open()
    await transport.close()
    expect(fake.adminClient.disconnects).toBe(1)
    expect(session.dialect.id).toBe('generic')
    expect(session.config.kind).toBe('kafka')
  })
})
