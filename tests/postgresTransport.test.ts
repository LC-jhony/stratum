import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

interface FakeClient extends EventEmitter {
  processID: number
  opts: Record<string, unknown>
  calls: unknown[]
}

const state = vi.hoisted(() => ({
  clients: [] as FakeClient[],
  active: 0,
  maxActive: 0,
  failNext: false,
  failCode: '',
}))

vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events')
  class Client extends EventEmitter {
    processID = 42
    calls: unknown[] = []
    constructor(public opts: Record<string, unknown>) { super(); state.clients.push(this as unknown as FakeClient) }
    async connect() { /* no-op */ }
    async query(q: { text?: string } | string) {
      const sql = typeof q === 'string' ? q : q.text ?? ''
      this.calls.push(q)
      if (/server_version/.test(sql)) return { rows: [{ server_version: '16.0' }], fields: [] }
      if (/^(set|show)\b/i.test(sql)) return { rows: [], fields: [] }
      if (state.failNext) {
        state.failNext = false
        const e = Object.assign(new Error('connection lost'), { code: state.failCode })
        throw e
      }
      state.active++
      state.maxActive = Math.max(state.maxActive, state.active)
      await new Promise((r) => setTimeout(r, 15))
      state.active--
      return { rows: [[1]], fields: [], rowCount: 1 }
    }
    async end() { /* no-op */ }
  }
  return { Client }
})

import { PostgresTransport } from '../src/main/db/transports/postgres'

const cfg = { id: 'p', name: 'p', kind: 'postgres' as const, host: 'localhost' }

describe('PostgresTransport hardening', () => {
  it('serialises concurrent queries on the single client (pg@9 removes parallel queries)', async () => {
    state.clients.length = 0; state.maxActive = 0
    const t = new PostgresTransport(cfg)
    await t.open()
    await Promise.all([t.query('select 1'), t.query('select 2'), t.query('select 3')])
    expect(state.maxActive).toBe(1)
    expect(state.clients).toHaveLength(1)
    await t.close()
  })

  it('survives an idle socket error and reconnects on the next query', async () => {
    state.clients.length = 0
    const t = new PostgresTransport(cfg)
    await t.open()
    state.clients[0].emit('error', new Error('server closed the connection'))
    const r = await t.query('select 1')
    expect(r.rows).toEqual([[1]])
    expect(state.clients).toHaveLength(2)
    await t.close()
  })

  it('re-applies the read-only policy after a reconnect', async () => {
    state.clients.length = 0
    const t = new PostgresTransport({ ...cfg, readonly: true })
    await t.open()
    state.clients[0].emit('error', new Error('gone'))
    await t.query('select 1')
    const calls = state.clients[1].calls.map((c) => (typeof c === 'string' ? c : (c as { text: string }).text))
    expect(calls.some((s) => /default_transaction_read_only = on/.test(s))).toBe(true)
    await t.close()
  })

  it('never reconnects in the middle of a transaction', async () => {
    state.clients.length = 0
    const t = new PostgresTransport(cfg)
    await t.open()
    await t.query('BEGIN')
    state.failNext = true; state.failCode = '08006'
    await expect(t.query('update t set x = 1')).rejects.toThrow(/lost during a transaction/i)
    await expect(t.query('select 1')).rejects.toThrow(/Roll back/i)
    expect(state.clients).toHaveLength(1)
    await t.close()
  })

  it('turns SSL verification on only when the profile asks for it', async () => {
    state.clients.length = 0
    await new PostgresTransport({ ...cfg, ssl: true }).open()
    expect(state.clients[0].opts.ssl).toEqual({ rejectUnauthorized: false })
    await new PostgresTransport({ ...cfg, ssl: true, sslVerify: true }).open()
    expect(state.clients[1].opts.ssl).toEqual({ rejectUnauthorized: true })
  })
})
