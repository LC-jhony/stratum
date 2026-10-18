import { promises as fs } from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import type { ConnectionConfig } from '../../shared/types'

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

export class ConnectionStore {
  constructor(private store: JsonStore<{ connections: ConnectionConfig[] }>) {}
  async list(): Promise<ConnectionConfig[]> { return (await this.store.read()).connections.map((c) => ({ ...c, password: unseal(c.password) })) }
  async save(c: ConnectionConfig) {
    const s = await this.store.read()
    const sealed = { ...c, password: seal(c.password) }
    const i = s.connections.findIndex((x) => x.id === c.id)
    if (i >= 0) s.connections[i] = sealed; else s.connections.push(sealed)
    await this.store.write(s)
  }
  async remove(id: string) { const s = await this.store.read(); s.connections = s.connections.filter((c) => c.id !== id); await this.store.write(s) }
  async get(id: string) { return (await this.list()).find((c) => c.id === id) }
}
