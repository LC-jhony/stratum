import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^sealed:/, ''),
  },
}))

const { ConnectionStore, JsonStore } = await import('../src/main/services/store')
type Store = InstanceType<typeof ConnectionStore>
import type { ConnectionConfig } from '../src/shared/types'

let dir: string
let store: Store

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'stratum-store-'))
  store = new ConnectionStore(new JsonStore<{ connections: ConnectionConfig[] }>(path.join(dir, 'connections.json'), { connections: [] }))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const config = (over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: 'c1',
  name: 'local',
  kind: 'postgres',
  host: 'localhost',
  port: 5432,
  user: 'ana',
  password: 'secret',
  ssh: { enabled: true, host: 'jump', user: 'root', authType: 'password', password: 'ssh-secret', passphrase: 'key-secret' },
  ...over,
})

describe('ConnectionStore secret handling', () => {
  it('never returns passwords or SSH secrets in list()', async () => {
    await store.save(config())
    const [view] = await store.list()
    expect(view).toMatchObject({ id: 'c1', hasPassword: true })
    expect(view.password).toBeUndefined()
    expect(view.ssh).toMatchObject({ enabled: true, host: 'jump', hasPassword: true, hasPassphrase: true })
    expect(view.ssh?.password).toBeUndefined()
    expect(view.ssh?.passphrase).toBeUndefined()
  })

  it('decrypts for main-process consumers only', async () => {
    await store.save(config())
    const full = await store.get('c1')
    expect(full?.password).toBe('secret')
    expect(full?.ssh?.password).toBe('ssh-secret')
    expect(full?.ssh?.passphrase).toBe('key-secret')
  })

  it('preserves omitted secrets when a view is saved back', async () => {
    await store.save(config())
    const view = (await store.list())[0]
    const edited: ConnectionConfig = {
      ...view,
      name: 'renamed',
      password: undefined,
      ssh: view.ssh ? { ...view.ssh, password: undefined, passphrase: undefined } : undefined,
    }
    await store.save(edited)
    const full = await store.get('c1')
    expect(full).toMatchObject({ name: 'renamed', password: 'secret' })
    expect(full?.ssh?.password).toBe('ssh-secret')
    expect(full?.ssh?.passphrase).toBe('key-secret')
  })

  it('replaces a secret only when a new value is supplied', async () => {
    await store.save(config())
    await store.save(config({ password: 'new-secret', ssh: { enabled: true, host: 'jump', password: 'new-ssh' } }))
    const full = await store.get('c1')
    expect(full?.password).toBe('new-secret')
    expect(full?.ssh?.password).toBe('new-ssh')
  })
})
