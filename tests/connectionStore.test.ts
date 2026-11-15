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

describe('ConnectionStore: TLS and jump-host secrets', () => {
  const withSecrets = (over: Partial<ConnectionConfig> = {}): ConnectionConfig => config({
    sslKeyPassphrase: 'ssl-secret',
    ssh: {
      enabled: true, host: 'jump', user: 'root', authType: 'password', password: 'ssh-secret', passphrase: 'key-secret',
      jumpHosts: [
        { id: 'j1', host: 'bastion-a', port: 22, user: 'root', authType: 'password', password: 'jump-secret', passphrase: 'jump-pass' },
        { id: 'j2', host: 'bastion-b', port: 22, user: 'root', authType: 'agent' },
      ],
    },
    ...over,
  })

  it('never exposes TLS passphrases or jump-host secrets in list()', async () => {
    await store.save(withSecrets())
    const [view] = await store.list()
    expect(view.hasSslKeyPassphrase).toBe(true)
    expect(view.sslKeyPassphrase).toBeUndefined()
    expect(view.ssh?.jumpHosts?.map((j) => ({ id: j.id, hasPassword: j.hasPassword, password: j.password }))).toEqual([
      { id: 'j1', hasPassword: true, password: undefined },
      { id: 'j2', hasPassword: false, password: undefined },
    ])
    expect(view.ssh?.jumpHosts?.[0].hasPassphrase).toBe(true)
    expect(view.ssh?.jumpHosts?.[0].passphrase).toBeUndefined()
  })

  it('decrypts TLS and jump-host secrets for main-process consumers', async () => {
    await store.save(withSecrets())
    const full = await store.get('c1')
    expect(full?.sslKeyPassphrase).toBe('ssl-secret')
    expect(full?.ssh?.jumpHosts?.[0]).toMatchObject({ password: 'jump-secret', passphrase: 'jump-pass' })
  })

  it('keeps omitted jump-host secrets by id and drops removed hosts', async () => {
    await store.save(withSecrets())
    const view = (await store.list())[0]
    const edited: ConnectionConfig = {
      ...view,
      sslKeyPassphrase: undefined,
      ssh: view.ssh ? {
        ...view.ssh,
        password: undefined,
        passphrase: undefined,
        jumpHosts: [
          { id: 'j1', host: 'renamed-bastion', port: 22, user: 'root', authType: 'password', password: undefined, passphrase: undefined },
        ],
      } : undefined,
    }
    await store.save(edited)
    const full = await store.get('c1')
    expect(full?.sslKeyPassphrase).toBe('ssl-secret')
    expect(full?.ssh?.password).toBe('ssh-secret')
    expect(full?.ssh?.jumpHosts).toHaveLength(1)
    expect(full?.ssh?.jumpHosts?.[0]).toMatchObject({ id: 'j1', host: 'renamed-bastion', password: 'jump-secret', passphrase: 'jump-pass' })
  })

  it('does not copy a secret from a different jump host', async () => {
    await store.save(withSecrets())
    const view = (await store.list())[0]
    await store.save({
      ...view,
      ssh: view.ssh ? {
        ...view.ssh,
        jumpHosts: [{ id: 'new-host', host: 'new', port: 22, user: 'root', authType: 'password', password: 'fresh' }],
      } : undefined,
    })
    const full = await store.get('c1')
    expect(full?.ssh?.jumpHosts?.[0]).toMatchObject({ id: 'new-host', password: 'fresh' })
    expect(full?.ssh?.jumpHosts?.[0].passphrase).toBeUndefined()
  })

  it('saves an imported batch with one write and no secrets', async () => {
    await store.saveMany([
      config({ id: 'a', name: 'a', password: undefined, ssh: undefined }),
      config({ id: 'b', name: 'b', password: undefined, ssh: undefined }),
    ])
    const views = await store.list()
    expect(views.map((v) => v.id)).toEqual(['a', 'b'])
    expect(views.every((v) => !v.hasPassword)).toBe(true)
    expect(await store.get('a')).toMatchObject({ name: 'a', password: undefined })
  })
})
