import { promises as fs } from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import type { ConnectionConfig, ConnectionView, SshConfig } from '../../shared/types'

/** Tiny atomic JSON store (write temp file then rename) so a crash never corrupts config. */
export class JsonStore<T extends object> {
  private cache?: T
  private seq = 0
  constructor(private file: string, private defaults: T) {}
  async read(): Promise<T> {
    if (this.cache) return this.cache
    try { this.cache = { ...this.defaults, ...JSON.parse(await fs.readFile(this.file, 'utf8')) } } catch { this.cache = structuredClone(this.defaults) }
    return this.cache!
  }
  async write(next: T) {
    this.cache = next
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${++this.seq}.tmp`
    await fs.writeFile(tmp, JSON.stringify(next, null, 2))
    await fs.rename(tmp, this.file)
  }
}

const PREFIX = 'enc:'
/** Passwords are encrypted with the OS keychain (DPAPI / Keychain / libsecret) when available. */
export const seal = (s?: string) => (s && safeStorage.isEncryptionAvailable() ? PREFIX + safeStorage.encryptString(s).toString('base64') : s)
export const unseal = (s?: string) => (s?.startsWith(PREFIX) ? safeStorage.decryptString(Buffer.from(s.slice(PREFIX.length), 'base64')) : s)

/** Strip secrets from a persisted connection; the renderer only needs to know whether they exist. */
export function connectionView(c: ConnectionConfig): ConnectionView {
  const { password, ssh, ...rest } = c
  return {
    ...rest,
    hasPassword: !!password,
    ssh: ssh
      ? {
          ...ssh,
          password: undefined,
          passphrase: undefined,
          hasPassword: !!ssh.password,
          hasPassphrase: !!ssh.passphrase,
        }
      : undefined,
  }
}

const unsealSsh = (ssh?: SshConfig): SshConfig | undefined =>
  ssh ? { ...ssh, password: unseal(ssh.password), passphrase: unseal(ssh.passphrase) } : undefined

/** Keep an existing secret when the renderer omitted it (blank field means "unchanged"). */
const mergeSecrets = (next: ConnectionConfig, previous?: ConnectionConfig): ConnectionConfig => {
  const password = next.password === undefined ? previous?.password : seal(next.password)
  const ssh = next.ssh
    ? {
        ...next.ssh,
        password: next.ssh.password === undefined ? previous?.ssh?.password : seal(next.ssh.password),
        passphrase: next.ssh.passphrase === undefined ? previous?.ssh?.passphrase : seal(next.ssh.passphrase),
      }
    : undefined
  return { ...next, password, ssh }
}

export class ConnectionStore {
  constructor(private store: JsonStore<{ connections: ConnectionConfig[] }>) {}

  /** Safe metadata for the explorer and the edit dialog. Secrets are never decrypted here. */
  async list(): Promise<ConnectionView[]> { return (await this.store.read()).connections.map(connectionView) }

  async save(c: ConnectionConfig) {
    const s = await this.store.read()
    const i = s.connections.findIndex((x) => x.id === c.id)
    const previous = i >= 0 ? s.connections[i] : undefined
    const sealed = mergeSecrets(c, previous)
    if (i >= 0) s.connections[i] = sealed; else s.connections.push(sealed)
    await this.store.write(s)
  }

  async remove(id: string) { const s = await this.store.read(); s.connections = s.connections.filter((c) => c.id !== id); await this.store.write(s) }

  /** Full config with decrypted secrets. Main-process use only (session open/test). */
  async get(id: string): Promise<ConnectionConfig | undefined> {
    const c = (await this.store.read()).connections.find((x) => x.id === id)
    return c ? { ...c, password: unseal(c.password), ssh: unsealSsh(c.ssh) } : undefined
  }
}
