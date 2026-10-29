import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

interface FakeConn extends EventEmitter {
  threadId: number
  opts: Record<string, unknown>
  calls: unknown[]
}

const state = vi.hoisted(() => ({ conns: [] as FakeConn[], failNext: false, failCode: '' }))

vi.mock('mysql2/promise', async () => {
  const { EventEmitter } = await import('node:events')
  class Connection extends EventEmitter {
    threadId = 77
    calls: unknown[] = []
    constructor(public opts: Record<string, unknown>) { super(); state.conns.push(this as unknown as FakeConn) }
    async query(q: string | { sql: string }) {
      const sql = typeof q === 'string' ? q : q.sql
      this.calls.push(q)
      if (/version\(\)/.test(sql)) return [[['8.0.36']], []]
      if (/^(set|kill)\b/i.test(sql)) return [[], []]
      if (state.failNext) {
        state.failNext = false
        throw Object.assign(new Error('connection lost'), { code: state.failCode })
      }
      return [[[1]], [{ name: 'x' }]]
    }
    async end() { /* no-op */ }
  }
  return { createConnection: async (opts: Record<string, unknown>) => new Connection(opts) }
})

import { MysqlTransport } from '../src/main/db/transports/mysql'

const cfg = { id: 'm', name: 'm', kind: 'mysql' as const, host: 'localhost' }

describe('MysqlTransport hardening', () => {
  it('survives an idle socket error and reconnects on the next query', async () => {
    state.conns.length = 0
    const t = new MysqlTransport(cfg)
    await t.open()
    state.conns[0].emit('error', new Error('server closed the connection'))
    const r = await t.query('select 1')
    expect(r.rows).toEqual([[1]])
    expect(state.conns).toHaveLength(2)
    await t.close()
  })

  it('re-applies read-only after reconnecting', async () => {
    state.conns.length = 0
    const t = new MysqlTransport({ ...cfg, readonly: true })
    await t.open()
    state.conns[0].emit('error', new Error('gone'))
    await t.query('select 1')
    expect(state.conns[1].calls).toContain('set session transaction read only')
    await t.close()
  })

  it('does not reconnect inside a transaction', async () => {
    state.conns.length = 0
    const t = new MysqlTransport(cfg)
    await t.open()
    await t.query('BEGIN')
    state.failNext = true; state.failCode = 'PROTOCOL_CONNECTION_LOST'
    await expect(t.query('update t set x = 1')).rejects.toThrow(/lost during a transaction/i)
    await expect(t.query('select 1')).rejects.toThrow(/Roll back/i)
    expect(state.conns).toHaveLength(1)
    await t.close()
  })

  it('honours sslVerify when SSL is on', async () => {
    state.conns.length = 0
    await new MysqlTransport({ ...cfg, ssl: true }).open()
    expect(state.conns[0].opts.ssl).toEqual({ rejectUnauthorized: false })
    await new MysqlTransport({ ...cfg, ssl: true, sslVerify: true }).open()
    expect(state.conns[1].opts.ssl).toEqual({ rejectUnauthorized: true })
  })
})
