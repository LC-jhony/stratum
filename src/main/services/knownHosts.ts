import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * Trust-on-first-use for SSH host keys.
 *
 * The first key seen for a host:port is recorded; later connections must present the same key.
 * A changed key aborts the handshake with an actionable message, which is the only defence
 * against a man-in-the-middle once a password is sent. The file is plain JSON (no secrets):
 * it stores the key algorithm and the OpenSSH-style SHA256 fingerprint.
 */

export interface KnownHostKey {
  /** Wire key algorithm, e.g. `ssh-ed25519` or `rsa-sha2-512`. */
  type: string
  /** `SHA256:` + unpadded base64 of the key blob, as `ssh-keygen -lf` prints it. */
  fingerprint: string
  addedAt: string
  lastSeenAt: string
}

interface KnownHostsFile {
  version: 1
  hosts: Record<string, KnownHostKey[]>
}

const EMPTY: KnownHostsFile = { version: 1, hosts: {} }

/** OpenSSH addresses hosts as `name:port`; names are case-insensitive. */
export const hostId = (host: string, port: number): string => `${host.trim().toLowerCase()}:${port}`

/** The key type is the first length-prefixed string of the SSH wire-format public key blob. */
export function keyTypeOf(blob: Buffer): string {
  if (blob.length < 5) throw new Error('The SSH server sent a truncated host key.')
  const len = blob.readUInt32BE(0)
  if (len < 1 || len > 64 || 4 + len > blob.length) throw new Error('The SSH server sent a host key with an invalid type field.')
  const type = blob.subarray(4, 4 + len).toString('ascii')
  if (!/^[a-z0-9@.-]+$/i.test(type)) throw new Error('The SSH server sent a host key with an unrecognised type.')
  return type
}

export const fingerprintOf = (blob: Buffer): string =>
  `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`

export interface HostKeyCheck {
  /** True when the key was unknown and has just been recorded (trust on first use). */
  added: boolean
  type: string
  fingerprint: string
}

/** Mismatch message: names both fingerprints so the user can compare them out of band. */
const mismatch = (id: string, known: KnownHostKey, seen: { type: string; fingerprint: string }) =>
  new Error(
    `SSH host key verification failed for ${id}: the server now presents ${seen.type} ${seen.fingerprint}, ` +
      `but ${known.type} ${known.fingerprint} was trusted on ${known.addedAt}. ` +
      'This can mean the server was reinstalled — or that the connection is being intercepted. ' +
      `If you trust the new key, remove the ${id} entry from the known_hosts file and reconnect.`,
  )

/**
 * One JSON file shared by every SSH tunnel. Reads and writes are serialised so two data sources
 * connecting at once cannot lose an entry or both accept different keys for the same host.
 */
export class KnownHosts {
  private cache?: KnownHostsFile
  private queue: Promise<unknown> = Promise.resolve()

  constructor(readonly file: string) {}

  private async load(): Promise<KnownHostsFile> {
    if (this.cache) return this.cache
    let raw: string
    try {
      raw = await fs.readFile(this.file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      this.cache = structuredClone(EMPTY)
      return this.cache
    }
    try {
      const parsed = JSON.parse(raw) as Partial<KnownHostsFile>
      if (!parsed || typeof parsed !== 'object' || typeof parsed.hosts !== 'object' || parsed.hosts === null) throw new Error('shape')
      this.cache = { version: 1, hosts: parsed.hosts as Record<string, KnownHostKey[]> }
    } catch {
      // Fail closed: silently emptying the file would turn every known host into "trusted again".
      throw new Error(`The SSH known-hosts file ${this.file} is not valid JSON. Fix or delete it, then reconnect.`)
    }
    return this.cache
  }

  private async save(next: KnownHostsFile): Promise<void> {
    this.cache = next
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(next, null, 2))
    await fs.rename(tmp, this.file)
  }

  /** Accepts a matching key, records an unknown one, rejects a changed one. */
  verify(host: string, port: number, blob: Buffer): Promise<HostKeyCheck> {
    const run = this.queue.then(async (): Promise<HostKeyCheck> => {
      const id = hostId(host, port)
      const type = keyTypeOf(blob)
      const fingerprint = fingerprintOf(blob)
      const file = await this.load()
      const keys = file.hosts[id] ?? []
      const sameType = keys.filter((k) => k.type === type)
      const known = sameType.find((k) => k.fingerprint === fingerprint)
      if (known) {
        // Keep lastSeenAt fresh, but avoid a write on every single connection.
        if (Date.now() - Date.parse(known.lastSeenAt) > 86_400_000) {
          known.lastSeenAt = new Date().toISOString()
          await this.save(file)
        }
        return { added: false, type, fingerprint }
      }
      if (sameType.length) throw mismatch(id, sameType[0], { type, fingerprint })
      // Another algorithm for the same host is allowed only as an additional key (servers rotate
      // algorithms); an existing key of the same type with a different value is the mismatch above.
      const now = new Date().toISOString()
      await this.save({ ...file, hosts: { ...file.hosts, [id]: [...keys, { type, fingerprint, addedAt: now, lastSeenAt: now }] } })
      console.warn(`[ssh] trusting host key ${type} ${fingerprint} for ${id} (first use)`)
      return { added: true, type, fingerprint }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Removes every key for a host (the "I reinstalled the server" escape hatch). */
  forget(host: string, port: number): Promise<void> {
    const run = this.queue.then(async () => {
      const file = await this.load()
      const id = hostId(host, port)
      if (!file.hosts[id]) return
      const hosts = { ...file.hosts }
      delete hosts[id]
      await this.save({ ...file, hosts })
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  async list(): Promise<Record<string, KnownHostKey[]>> {
    return (await this.load()).hosts
  }
}

let configured: KnownHosts | undefined

/** Called once at startup with the user-data path; tests call it with a temporary file. */
export function configureKnownHosts(file: string): KnownHosts {
  configured = new KnownHosts(file)
  return configured
}

export function knownHosts(): KnownHosts {
  // main/index.ts configures the user-data path; this fallback only serves code paths imported
  // outside the app (never silently forget keys by using a temporary directory).
  if (!configured) configured = new KnownHosts(path.join(process.env.STRATUM_CONFIG_DIR ?? path.join(homedir(), '.stratum'), 'known_hosts.json'))
  return configured
}
