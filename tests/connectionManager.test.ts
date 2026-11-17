import { describe, expect, it } from 'vitest'
import type { DbSession } from '../src/main/db/session'
import { ConnectionManager } from '../src/main/services/connectionManager'
import type { SessionFactory } from '../src/main/services/sessionFactory'
import type { ConnectionStore } from '../src/main/services/store'
import type { ConnectionConfig } from '../src/shared/types'

const cfg: ConnectionConfig = { id: 'c1', name: 'Primary', kind: 'postgres', host: 'db.internal' }
const store = { get: async () => cfg } as unknown as ConnectionStore
const factory = (create: () => Promise<DbSession>) => ({ createWithTunnel: create }) as unknown as SessionFactory
const session = (open: () => Promise<{ version?: string }>) => ({
  config: cfg,
  open,
  close: async () => undefined,
  transaction: () => ({ open: false, autoCommit: true }),
  ping: async () => undefined,
  validate: async () => undefined,
}) as unknown as DbSession

describe('connection test result', () => {
  it('reports the round trip, version and driver', async () => {
    const manager = new ConnectionManager(store, factory(async () => session(async () => ({ version: '16.1' }))), { tickMs: 3_600_000 })
    const result = await manager.test(cfg)
    expect(result).toMatchObject({ ok: true, version: '16.1', driver: 'pg' })
    expect(result.latencyMs).toBeGreaterThan(0)
    manager.stop()
  })

  it('classifies authentication failures with an actionable hint', async () => {
    const manager = new ConnectionManager(store, factory(async () => session(async () => {
      throw new Error('password authentication failed for user "ana"')
    })), { tickMs: 3_600_000 })
    const result = await manager.test(cfg)
    expect(result).toMatchObject({ ok: false, code: 'auth', stage: 'auth' })
    expect(result.hint).toMatch(/credentials/i)
    expect(result.error).toMatch(/password authentication failed/)
    manager.stop()
  })

  it('blames the SSH helper when the tunnel cannot be created', async () => {
    const manager = new ConnectionManager(store, factory(async () => {
      throw new Error('All configured authentication methods failed')
    }), { tickMs: 3_600_000 })
    const result = await manager.test({ ...cfg, ssh: { enabled: true, host: 'jump' } })
    expect(result).toMatchObject({ ok: false, code: 'tunnel', stage: 'tunnel' })
    manager.stop()
  })

  it('redacts secrets echoed by the driver', async () => {
    const manager = new ConnectionManager(store, factory(async () => session(async () => {
      throw new Error('password authentication failed for postgresql://ana:hunter2@db.internal/shop?password=other')
    })), { tickMs: 3_600_000 })
    const result = await manager.test(cfg)
    expect(result.error).toContain('password authentication failed')
    expect(result.error).not.toContain('hunter2')
    expect(result.error).not.toContain('other')
    manager.stop()
  })
})
