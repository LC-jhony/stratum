import { randomUUID } from 'node:crypto'
import { Kafka, logLevel } from 'kafkajs'
import type { ColumnMeta, ConnectionConfig, RawResult, SchemaInfo, TableInfo } from '../../../shared/types'
import type { Transport } from '../types'

/**
 * Kafka transport (read-only MVP).
 *
 * There is no query console: the Explorer lists topics as tables under one `topics` schema and the
 * data editor peeks at messages with the internal reader `CONSUME "<topic>" <offset> <limit>`.
 *
 * A peek is bounded on purpose. It reads the topic's retained offsets first and, when the topic is
 * not empty, joins a transient unique consumer group with auto-commit disabled, subscribes with
 * `fromBeginning`, and stops as soon as the requested window is filled, the retained messages run
 * out, or a 10 s budget expires (5 000 messages walked at most). The budget is generous because the
 * first peek against a fresh broker pays for the consumer-group join. No offsets are committed,
 * nothing is produced, and the group disappears once the consumer disconnects.
 *
 * Messages map to `partition`, `offset`, `timestamp`, `key`, `value` and `headers`. Keys/values are
 * decoded as UTF-8 when valid (long values truncated) and shown as `0x…` hex otherwise; headers are
 * a JSON object of decoded values.
 */

const DEFAULT_PORT = 9092
const MAX_TOPICS = 200
const MAX_WALK = 5000
/** Generous because the first peek against a fresh broker pays for the consumer-group join. */
const BUDGET_MS = 10_000
const MAX_TEXT = 2000

export const MESSAGE_COLUMNS: ColumnMeta[] = [
  { name: 'partition' },
  { name: 'offset' },
  { name: 'timestamp' },
  { name: 'key' },
  { name: 'value' },
  { name: 'headers' },
]

export interface KafkaAdminLike {
  connect(): Promise<void>
  disconnect(): Promise<void>
  listTopics(): Promise<string[]>
  fetchTopicOffsets(topic: string): Promise<{ partition: number; low: string; high: string }[]>
}

export interface KafkaMessageLike {
  partition: number
  offset: string
  timestamp: string
  key: Buffer | string | null
  value: Buffer | string | null
  headers?: Record<string, Buffer | string | (Buffer | string)[] | undefined>
}

export interface KafkaConsumerLike {
  connect(): Promise<void>
  subscribe(options: { topic: string; fromBeginning?: boolean }): Promise<void>
  run(options: {
    autoCommit?: boolean
    eachMessage: (payload: { topic: string; partition: number; message: KafkaMessageLike }) => Promise<void>
  }): Promise<void>
  stop(): Promise<void>
  disconnect(): Promise<void>
}

export interface KafkaClientLike {
  admin(): KafkaAdminLike
  consumer(options: { groupId: string }): KafkaConsumerLike
}
export type KafkaClientFactory = (cfg: ConnectionConfig) => KafkaClientLike

/** `host1:9092,host2:9092` (or bare hosts, completed with the configured port). */
export function brokersOf(cfg: ConnectionConfig): string[] {
  const raw = cfg.host?.trim()
  if (!raw) return [`localhost:${DEFAULT_PORT}`]
  const port = cfg.port && cfg.port > 0 ? cfg.port : DEFAULT_PORT
  return raw
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean)
    .map((broker) => (broker.includes(':') ? broker : `${broker}:${port}`))
}

export function createKafkaClient(cfg: ConnectionConfig): KafkaClientLike {
  const kafka = new Kafka({
    clientId: 'stratum',
    brokers: brokersOf(cfg),
    logLevel: logLevel.NOTHING,
    ssl: cfg.ssl ? true : undefined,
    sasl: cfg.user?.trim() ? { mechanism: 'plain', username: cfg.user.trim(), password: cfg.password ?? '' } : undefined,
    connectionTimeout: 5000,
    requestTimeout: 15000,
    retry: { retries: 2 },
  })
  return {
    admin: () => kafka.admin() as unknown as KafkaAdminLike,
    consumer: (options) => kafka.consumer(options) as unknown as KafkaConsumerLike,
  }
}

export interface KafkaPeek {
  topic: string
  offset: number
  limit: number
}

const CONSUME_STATEMENT = /^CONSUME[ \t]+("(?:[^"\\]|\\.)*"|\S+)(?:[ \t]+(\d+))?(?:[ \t]+(\d+))?[ \t]*;?[ \t]*$/i

/** `CONSUME "<topic>" [offset] [limit]` — the only statement this transport executes. */
export function parseKafkaConsume(stmt: string): KafkaPeek | undefined {
  const m = CONSUME_STATEMENT.exec(stmt.trim())
  if (!m) return undefined
  let topic = m[1]
  if (topic.startsWith('"')) {
    try { topic = String(JSON.parse(topic)) } catch { /* keep the raw token */ }
  }
  return { topic, offset: Number(m[2] ?? 0) || 0, limit: Number(m[3] ?? 500) || 500 }
}

export function isKafkaRead(stmt: string): boolean {
  return parseKafkaConsume(stmt) !== undefined
}

export function paginateKafkaStatement(stmt: string, limit: number, offset: number): string | undefined {
  const peek = parseKafkaConsume(stmt)
  return peek ? `CONSUME ${JSON.stringify(peek.topic)} ${offset} ${limit}` : undefined
}

export class KafkaTransport implements Transport {
  private client: KafkaClientLike
  private admin: KafkaAdminLike

  constructor(private cfg: ConnectionConfig, make: KafkaClientFactory = createKafkaClient) {
    this.client = make(cfg)
    this.admin = this.client.admin()
  }

  async open(): Promise<{ version?: string }> {
    try {
      await this.admin.connect()
      await this.admin.listTopics() // validates credentials/permissions, not just the socket
      return {} // Kafka exposes no server version
    } catch (e) {
      await this.admin.disconnect().catch(() => undefined)
      throw new Error(`Kafka connection to ${this.target()} failed: ${msg(e)}`)
    }
  }

  async query(stmt: string): Promise<RawResult> {
    const peek = parseKafkaConsume(stmt)
    if (!peek) throw new Error('Kafka has no query console in this build: open a topic in the Explorer to peek at messages.')
    return this.peek(peek.topic, peek.offset, peek.limit)
  }

  async cancel(): Promise<void> { /* a peek is bounded by its own budget; close stays explicit */ }

  async close(): Promise<void> {
    await this.admin.disconnect().catch(() => undefined)
  }

  async introspectModel(): Promise<{ schemas: SchemaInfo[] }> {
    const topics = (await this.admin.listTopics())
      .filter((topic) => !topic.startsWith('__'))
      .sort()
      .slice(0, MAX_TOPICS)
    return { schemas: [{ name: 'topics', tables: topics.map(topicTable) }] }
  }

  /* -------------------------------------------------- peek */

  private async peek(topic: string, offset: number, limit: number): Promise<RawResult> {
    const offsets = await this.admin.fetchTopicOffsets(topic)
    const remaining = new Map<number, number>()
    let total = 0
    for (const part of offsets) {
      const count = Math.max(0, Number(part.high) - Number(part.low))
      remaining.set(part.partition, count)
      total += count
    }
    if (total <= offset) return { columns: MESSAGE_COLUMNS, rows: [] }

    if (offset >= MAX_WALK) throw new Error(`Kafka peeking is capped at ${MAX_WALK} messages; this page starts beyond the cap.`)
    const target = Math.min(offset + limit, MAX_WALK)
    const rows: unknown[][] = []
    let seen = 0
    let failure: Error | undefined
    let expired = false
    let finish = (): void => undefined
    const finished = new Promise<void>((resolve) => { finish = resolve })
    const consumer = this.client.consumer({ groupId: `stratum-peek-${randomUUID()}` })
    const timer = setTimeout(() => { expired = true; finish() }, BUDGET_MS)
    try {
      await consumer.connect()
      await consumer.subscribe({ topic, fromBeginning: true })
      const running = consumer.run({
        autoCommit: false,
        eachMessage: async ({ partition, message }) => {
          const left = remaining.get(partition)
          if (left !== undefined && left > 0) remaining.set(partition, left - 1)
          seen += 1
          if (seen > offset && rows.length < limit) rows.push(messageRow(partition, message))
          const drained = [...remaining.values()].every((count) => count <= 0)
          if (rows.length >= limit || seen >= target || drained) finish()
        },
      }).catch((e) => {
        failure = e instanceof Error ? e : new Error(String(e))
        finish()
      })
      await finished
      await consumer.stop().catch(() => undefined)
      await running
      // A stop caused by the budget may abort the join: that is not a query error.
      if (failure && !expired) throw failure
      return { columns: MESSAGE_COLUMNS, rows }
    } finally {
      clearTimeout(timer)
      await consumer.disconnect().catch(() => undefined)
    }
  }

  private target(): string {
    return brokersOf(this.cfg).join(',')
  }
}

/* ------------------------------------------------------------------ helpers */

function messageRow(partition: number, message: KafkaMessageLike): unknown[] {
  return [
    partition,
    Number(message.offset),
    timestampOf(message.timestamp),
    decodeBuffer(message.key),
    decodeBuffer(message.value),
    headersOf(message.headers),
  ]
}

function timestampOf(raw: string | undefined): unknown {
  if (!raw) return null
  const ms = Number(raw)
  return Number.isFinite(ms) ? new Date(ms) : raw
}

function decodeBuffer(value: Buffer | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return truncate(value)
  const text = value.toString('utf8')
  if (Buffer.from(text, 'utf8').equals(value)) return truncate(text)
  const head = value.subarray(0, 64).toString('hex')
  return `0x${head}${value.length > 64 ? '…' : ''}`
}

function truncate(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text
}

function headersOf(headers: KafkaMessageLike['headers']): Record<string, unknown> | null {
  if (!headers || Object.keys(headers).length === 0) return null
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(headers)) {
    out[name] = Array.isArray(value) ? value.map((entry) => decodeBuffer(entry)) : decodeBuffer(value)
  }
  return out
}

function topicTable(name: string): TableInfo {
  return {
    name,
    kind: 'table',
    columns: MESSAGE_COLUMNS.map((column, ordinal) => ({
      name: column.name,
      dataType: column.name === 'partition' || column.name === 'offset' ? 'int64' : column.name === 'timestamp' ? 'timestamp' : 'string',
      nullable: column.name !== 'partition' && column.name !== 'offset',
      isPrimaryKey: false,
      ordinal,
    })),
    foreignKeys: [],
    indexes: [],
  }
}

function msg(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause
    return cause instanceof Error ? `${e.message} (${cause.message})` : e.message
  }
  return String(e)
}
