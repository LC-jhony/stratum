import type { ColumnMeta, ConnectionConfig, RawResult, SchemaInfo, TableInfo } from '../../../shared/types'
import type { Transport } from '../types'

/**
 * RabbitMQ transport (read-only MVP) over the Management HTTP API — `fetch` only, no dependency.
 *
 * There is no query console. The Explorer reads `/api/queues` (one schema per vhost, one table per
 * queue) and the data editor peeks with the internal reader `PEEK "<vhost>" "<queue>" <offset>
 * <limit>`. A peek is a `POST /api/queues/{vhost}/{queue}/get` with `ackmode: ack_requeue_true`, so
 * messages are delivered to the client and requeued untouched — nothing is acknowledged, rejected
 * or deleted. The API has no offset, so each page requests `offset + limit` messages from the head
 * (capped at 2 000), decodes them and slices the window locally.
 *
 * Payloads are requested as base64, decoded as UTF-8 when valid (truncated) or shown as `0x…` hex.
 * The management API expects the HTTP port (15672 by default), not the AMQP 5672 one.
 */

const DEFAULT_PORT = 15672
const MAX_QUEUES = 500
const MAX_FETCH = 2000
const REQUEST_TIMEOUT_MS = 15000
const TRUNCATE_BYTES = 20000
const MAX_TEXT = 2000

export const MESSAGE_COLUMNS: ColumnMeta[] = [
  { name: 'exchange' },
  { name: 'routingKey' },
  { name: 'redelivered' },
  { name: 'payload' },
  { name: 'properties' },
  { name: 'headers' },
]

interface ApiQueue {
  name?: unknown
  vhost?: unknown
}

interface ApiMessage {
  payload?: unknown
  payload_bytes?: unknown
  redelivered?: unknown
  exchange?: unknown
  routing_key?: unknown
  properties?: unknown
  headers?: unknown
}

export interface RabbitPeek {
  vhost: string
  queue: string
  offset: number
  limit: number
}

const PEEK_STATEMENT = /^PEEK[ \t]+("(?:[^"\\]|\\.)*"|\S+)[ \t]+("(?:[^"\\]|\\.)*"|\S+)(?:[ \t]+(\d+))?(?:[ \t]+(\d+))?[ \t]*;?[ \t]*$/i

function token(raw: string): string {
  if (!raw.startsWith('"')) return raw
  try { return String(JSON.parse(raw)) } catch { return raw.slice(1, -1) }
}

/** `PEEK "<vhost>" "<queue>" [offset] [limit]` — the only statement this transport executes. */
export function parseRabbitPeek(stmt: string): RabbitPeek | undefined {
  const m = PEEK_STATEMENT.exec(stmt.trim())
  if (!m) return undefined
  return { vhost: token(m[1]), queue: token(m[2]), offset: Number(m[3] ?? 0) || 0, limit: Number(m[4] ?? 500) || 500 }
}

export function isRabbitRead(stmt: string): boolean {
  return parseRabbitPeek(stmt) !== undefined
}

export function paginateRabbitStatement(stmt: string, limit: number, offset: number): string | undefined {
  const peek = parseRabbitPeek(stmt)
  return peek ? `PEEK ${JSON.stringify(peek.vhost)} ${JSON.stringify(peek.queue)} ${offset} ${limit}` : undefined
}

export class RabbitMqTransport implements Transport {
  private abort?: AbortController

  constructor(private cfg: ConnectionConfig) {}

  async open(): Promise<{ version?: string }> {
    try {
      const overview = await this.call<{ rabbitmq_version?: unknown }>('GET', '/api/overview')
      return { version: typeof overview?.rabbitmq_version === 'string' ? overview.rabbitmq_version : undefined }
    } catch (e) {
      throw new Error(`RabbitMQ connection to ${this.base()} failed: ${msg(e)}`)
    }
  }

  async query(stmt: string): Promise<RawResult> {
    const peek = parseRabbitPeek(stmt)
    if (!peek) throw new Error('RabbitMQ has no query console in this build: open a queue in the Explorer to peek at messages.')
    if (peek.offset >= MAX_FETCH) throw new Error(`RabbitMQ peeking is capped at ${MAX_FETCH} messages; this page starts beyond the cap.`)
    const count = Math.min(peek.offset + peek.limit, MAX_FETCH)
    if (count <= 0) return { columns: MESSAGE_COLUMNS, rows: [] }
    const messages = await this.call<ApiMessage[]>(
      'POST',
      `/api/queues/${encodeURIComponent(peek.vhost)}/${encodeURIComponent(peek.queue)}/get`,
      { count, ackmode: 'ack_requeue_true', encoding: 'base64', truncate: TRUNCATE_BYTES },
    )
    const list = Array.isArray(messages) ? messages : []
    return { columns: MESSAGE_COLUMNS, rows: list.slice(peek.offset, peek.offset + peek.limit).map(messageRow) }
  }

  async cancel(): Promise<void> { this.abort?.abort() }

  async close(): Promise<void> { this.abort?.abort() }

  async introspectModel(): Promise<{ schemas: SchemaInfo[] }> {
    const raw = await this.call<ApiQueue[] | { items?: ApiQueue[] }>('GET', `/api/queues?page=1&page_size=${MAX_QUEUES}`)
    const queues = (Array.isArray(raw) ? raw : raw?.items ?? [])
      .filter((queue) => typeof queue?.name === 'string' && typeof queue?.vhost === 'string')
      .slice(0, MAX_QUEUES)
    const byVhost = new Map<string, string[]>()
    for (const queue of queues) {
      const vhost = String(queue.vhost)
      const names = byVhost.get(vhost) ?? []
      names.push(String(queue.name))
      byVhost.set(vhost, names)
    }
    return {
      schemas: [...byVhost.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, tables]) => ({ name, tables: [...tables].sort().map(queueTable) })),
    }
  }

  private base(): string {
    const host = this.cfg.host?.trim()
    if (!host) throw new Error('Set the RabbitMQ management API host.')
    const port = this.cfg.port && this.cfg.port > 0 ? this.cfg.port : DEFAULT_PORT
    return `${this.cfg.ssl ? 'https' : 'http'}://${host}:${port}`
  }

  private headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (json) headers['Content-Type'] = 'application/json'
    const user = this.cfg.user?.trim()
    if (user) headers.Authorization = `Basic ${Buffer.from(`${user}:${this.cfg.password ?? ''}`).toString('base64')}`
    return headers
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController()
    this.abort = ctrl
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(`${this.base()}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      })
      const text = await res.text()
      let json: unknown
      try { json = text ? JSON.parse(text) : undefined } catch { json = undefined }
      if (!res.ok) throw new Error(describeError(res.status, res.statusText, json, text))
      return json as T
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw new Error(`RabbitMQ request aborted (cancelled or over ${REQUEST_TIMEOUT_MS / 1000}s): ${method} ${path}`)
      throw e instanceof Error ? e : new Error(String(e))
    } finally {
      clearTimeout(timer)
      if (this.abort === ctrl) this.abort = undefined
    }
  }
}

/* ------------------------------------------------------------------ helpers */

function describeError(status: number, statusText: string, body: unknown, text: string): string {
  const reason = body && typeof body === 'object'
    ? [(body as { error?: unknown }).error, (body as { reason?: unknown }).reason]
        .find((value): value is string => typeof value === 'string' && value.length > 0)
    : undefined
  const hint = status === 401 || status === 403 ? 'check the username/password and its management permissions' : ''
  const detail = reason ?? hint ?? text.slice(0, 200)
  return `RabbitMQ management API ${status}${statusText ? ` ${statusText}` : ''}${detail ? `: ${detail}` : ''}`
}

function queueTable(name: string): TableInfo {
  return {
    name,
    kind: 'table',
    columns: MESSAGE_COLUMNS.map((column, ordinal) => ({
      name: column.name,
      dataType: column.name === 'redelivered' ? 'boolean' : 'string',
      nullable: column.name !== 'payload',
      isPrimaryKey: false,
      ordinal,
    })),
    foreignKeys: [],
    indexes: [],
  }
}

function messageRow(message: ApiMessage): unknown[] {
  return [
    typeof message.exchange === 'string' ? message.exchange : null,
    typeof message.routing_key === 'string' ? message.routing_key : null,
    message.redelivered === true,
    payloadOf(message),
    objectOrNull(message.properties),
    objectOrNull(message.headers),
  ]
}

function payloadOf(message: ApiMessage): string | null {
  if (typeof message.payload !== 'string') return null
  const bytes = Buffer.from(message.payload, 'base64')
  const decoded = decodeBuffer(bytes)
  if (decoded === null) return null
  const original = Number(message.payload_bytes ?? bytes.length)
  return Number.isFinite(original) && original > bytes.length ? `${decoded}…` : decoded
}

function decodeBuffer(value: Buffer): string | null {
  if (value.length === 0) return ''
  const text = value.toString('utf8')
  if (Buffer.from(text, 'utf8').equals(value)) {
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text
  }
  const head = value.subarray(0, 64).toString('hex')
  return `0x${head}${value.length > 64 ? '…' : ''}`
}

function objectOrNull(value: unknown): unknown {
  if (!value || typeof value !== 'object') return null
  return Object.keys(value as Record<string, unknown>).length > 0 ? value : null
}

function msg(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause
    return cause instanceof Error ? `${e.message} (${cause.message})` : e.message
  }
  return String(e)
}
