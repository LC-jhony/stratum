import { Client } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '../src/shared/types'
import {
  createPostgresDebugSession, listDebugRoutines, probeDebugSupport,
} from '../src/main/debug/postgresDebugSession'

/**
 * End-to-end coverage against a disposable PostgreSQL with pldbgapi installed. It is skipped by
 * default because CI has no server; run it with STRATUM_PG_DEBUG=1 and the connection variables
 * below (see docs/architecture/phase-12.md for the exact setup).
 */
const cfg: ConnectionConfig = {
  id: 'debug-live',
  name: 'debug-live',
  kind: 'postgres',
  host: process.env.STRATUM_PG_HOST ?? '/tmp/opencode/pgsock',
  port: Number(process.env.STRATUM_PG_PORT ?? 55432),
  user: process.env.STRATUM_PG_USER ?? 'postgres',
  password: process.env.STRATUM_PG_PASSWORD,
  database: process.env.STRATUM_PG_DATABASE ?? 'postgres',
}

const live = process.env.STRATUM_PG_DEBUG === '1'
const noop = () => undefined

describe.skipIf(!live)('live PL/pgSQL debugger', () => {
  afterAll(async () => {
    const client = new Client({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database })
    await client.connect()
    await client.query('update debug_demo set total = 0 where id = 1')
    await client.end()
  })

  it('probes the extension and lists PL/pgSQL routines', async () => {
    const probe = await probeDebugSupport(cfg)
    expect(probe).toMatchObject({ available: true })
    expect(probe.proxyApiVersion).toBeGreaterThan(0)

    const routines = await listDebugRoutines(cfg)
    const fn = routines.find((r) => r.name === 'debug_add')
    expect(fn).toMatchObject({
      kind: 'function', language: 'plpgsql', returnsSet: false,
      arguments: [
        { name: 'p_id', type: 'integer', optional: false },
        { name: 'p_amount', type: 'numeric', optional: false },
      ],
    })
    const proc = routines.find((r) => r.name === 'debug_touch')
    expect(proc).toMatchObject({ kind: 'procedure', variadic: false })
    expect(proc?.arguments.map((a) => [a.name, a.optional])).toEqual([['p_id', false], ['p_total', true]])
  })

  it('stops at the entry, sets a line breakpoint, edits a variable and rolls back the result', async () => {
    const routines = await listDebugRoutines(cfg)
    const fn = routines.find((r) => r.name === 'debug_add')
    expect(fn).toBeDefined()

    const session = await createPostgresDebugSession('live-1', cfg, fn!.oid, ['1', '5'], noop)
    try {
      const started = session.snapshot()
      expect(started.status).toBe('paused')
      expect(started.source?.text).toContain('v_total := v_total + p_amount')
      expect(started.frames.length).toBeGreaterThan(0)

      // The implicit entry breakpoint stops on the first executable statement, not on DECLARE.
      const lines = started.source!.text.split('\n')
      expect(started.breakpoint?.line).toBeGreaterThan(0)
      expect(lines[started.breakpoint!.line - 1]).toContain('select total into v_total')

      const targetLine = lines.findIndex((line) => line.includes('v_total := v_total + p_amount')) + 1
      expect(targetLine).toBeGreaterThan(0)
      const withBreakpoint = await session.toggleBreakpoint(fn!.oid, targetLine, true)
      expect(withBreakpoint.error).toBeUndefined()
      expect(withBreakpoint.breakpoints).toContainEqual(expect.objectContaining({ oid: fn!.oid, line: targetLine }))

      const stopped = await session.step('continue')
      expect(stopped.status).toBe('paused')
      expect(stopped.breakpoint?.line).toBe(targetLine)
      expect(stopped.variables.find((v) => v.name === 'p_id')?.value).toBe('1')
      expect(stopped.variables.find((v) => v.name === 'p_amount')?.value).toBe('5')
      const total = stopped.variables.find((v) => v.name === 'v_total')
      expect(total).toBeDefined()

      const edited = await session.setVariable('v_total', total!.line, '100')
      expect(edited.error).toBeUndefined()
      expect(edited.variables.find((v) => v.name === 'v_total')?.value).toBe('100')

      const finished = await session.step('continue')
      expect(finished.status).toBe('finished')
      expect(finished.error).toBeUndefined()
      expect(finished.result?.rows[0]?.[0]).toBe('105')
    } finally {
      await session.stop()
    }

    const client = new Client({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database })
    await client.connect()
    const r = await client.query('select total from debug_demo where id = 1')
    await client.end()
    // The debug target runs in a transaction that stop() rolls back.
    expect(String(r.rows[0].total)).toBe('0')
  }, 60_000)

  it('runs a procedure with an omitted trailing default and stops it safely', async () => {
    const routine = (await listDebugRoutines(cfg)).find((r) => r.name === 'debug_touch')
    expect(routine).toBeDefined()
    const session = await createPostgresDebugSession('live-2', cfg, routine!.oid, ['1'], noop)
    const started = session.snapshot()
    expect(started.status).toBe('paused')
    expect(started.routine.kind).toBe('procedure')
    const stopped = await session.stop()
    expect(stopped.status).toBe('stopped')
  }, 60_000)
})
