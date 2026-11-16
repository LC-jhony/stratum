import { promises as fs } from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import type { ConnectionConfig, ConnectionView, SshConfig, SshJumpHost, SshJumpHostView } from '../../shared/types'
import { logger } from '../logger'

/** Tiny atomic JSON store (write temp file then rename) so a crash never corrupts config. */
export class JsonStore<T extends object> {
  private cache?: T
  private seq = 0
  constructor(private file: string, private defaults: T) {}
  async read(): Promise<T> {
    if (this.cache) return this.cache
    let raw: string
    try {
      raw = await fs.readFile(this.file, 'utf8')
    } catch (e) {
      // A missing file is the normal first run; anything else (permissions, I/O) must not wipe state.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      this.cache = structuredClone(this.defaults)
      return this.cache
    }
    try {
      this.cache = { ...this.defaults, ...JSON.parse(raw) }
    } catch {
      // Keep the broken file for inspection before falling back to defaults; never lose user data silently.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      await fs.copyFile(this.file, `${this.file}.corrupt-${stamp}`)
      logger.warn(`[store] ${this.file} is not valid JSON; a backup was saved as ${this.file}.corrupt-${stamp}`)
      this.cache = structuredClone(this.defaults)
    }
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
let warnedPlaintext = false
/** Passwords are encrypted with the OS keychain (DPAPI / Keychain / libsecret) when available. */
export const seal = (s?: string) => {
  if (!s) return s
  let available = false
  try { available = safeStorage.isEncryptionAvailable() } catch { available = false }
  if (!available) {
    if (!warnedPlaintext) {
      warnedPlaintext = true
      logger.warn('[store] safeStorage is unavailable: passwords will be stored in plain text in the connection file.')
    }
    return s
  }
  return PREFIX + safeStorage.encryptString(s).toString('base64')
}
export const unseal = (s?: string) => (s?.startsWith(PREFIX) ? safeStorage.decryptString(Buffer.from(s.slice(PREFIX.length), 'base64')) : s)

/** Strip secrets from a persisted connection; the renderer only needs to know whether they exist. */
export function connectionView(c: ConnectionConfig): ConnectionView {
  const { password, ssh, sslKeyPassphrase, proxy, ...rest } = c
  const sshView = ssh
    ? (() => {
        const { password: _password, passphrase: _passphrase, jumpHosts, ...sshRest } = ssh
        return {
          ...sshRest,
          hasPassword: !!ssh.password,
          hasPassphrase: !!ssh.passphrase,
          jumpHosts: jumpHosts?.map((j): SshJumpHostView => {
            const { password: _jp, passphrase: _jpp, ...jumpRest } = j
            return { ...jumpRest, hasPassword: !!j.password, hasPassphrase: !!j.passphrase }
          }),
        }
      })()
    : undefined
  const proxyView = proxy
    ? (() => {
        const { password: _proxyPassword, ...proxyRest } = proxy
        return { ...proxyRest, hasPassword: !!proxy.password }
      })()
    : undefined
  return { ...rest, hasPassword: !!password, hasSslKeyPassphrase: !!sslKeyPassphrase, ssh: sshView, proxy: proxyView }
}

const unsealJump = (j: SshJumpHost): SshJumpHost => ({ ...j, password: unseal(j.password), passphrase: unseal(j.passphrase) })
const unsealSsh = (ssh?: SshConfig): SshConfig | undefined =>
  ssh ? { ...ssh, password: unseal(ssh.password), passphrase: unseal(ssh.passphrase), jumpHosts: ssh.jumpHosts?.map(unsealJump) } : undefined

/** Keep an existing secret when the renderer omitted it (blank field means "unchanged"). */
const mergeSecrets = (next: ConnectionConfig, previous?: ConnectionConfig): ConnectionConfig => {
  const password = next.password === undefined ? previous?.password : seal(next.password)
  const prevJumps = new Map((previous?.ssh?.jumpHosts ?? []).map((j) => [j.id, j]))
  const ssh = next.ssh
    ? {
        ...next.ssh,
        password: next.ssh.password === undefined ? previous?.ssh?.password : seal(next.ssh.password),
        passphrase: next.ssh.passphrase === undefined ? previous?.ssh?.passphrase : seal(next.ssh.passphrase),
        jumpHosts: next.ssh.jumpHosts?.map((j) => {
          const prev = prevJumps.get(j.id)
          return {
            ...j,
            password: j.password === undefined ? prev?.password : seal(j.password),
            passphrase: j.passphrase === undefined ? prev?.passphrase : seal(j.passphrase),
          }
        }),
      }
    : undefined
  const sslKeyPassphrase = next.sslKeyPassphrase === undefined ? previous?.sslKeyPassphrase : seal(next.sslKeyPassphrase)
  const proxy = next.proxy
    ? { ...next.proxy, password: next.proxy.password === undefined ? previous?.proxy?.password : seal(next.proxy.password) }
    : undefined
  return { ...next, password, ssh, sslKeyPassphrase, proxy }
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

  /** Insert several data sources with one write, so a failed import never leaves a partial result. */
  async saveMany(configs: readonly ConnectionConfig[]) {
    if (!configs.length) return
    const s = await this.store.read()
    for (const c of configs) {
      const i = s.connections.findIndex((x) => x.id === c.id)
      const sealed = mergeSecrets(c, i >= 0 ? s.connections[i] : undefined)
      if (i >= 0) s.connections[i] = sealed
      else s.connections.push(sealed)
    }
    await this.store.write(s)
  }

  /** Full config with decrypted secrets. Main-process use only (session open/test). */
  async get(id: string): Promise<ConnectionConfig | undefined> {
    const c = (await this.store.read()).connections.find((x) => x.id === id)
    return c ? { ...c, password: unseal(c.password), sslKeyPassphrase: unseal(c.sslKeyPassphrase), ssh: unsealSsh(c.ssh), proxy: c.proxy ? { ...c.proxy, password: unseal(c.proxy.password) } : undefined } : undefined
  }
}
