import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { KnownHosts, fingerprintOf, hostId, keyTypeOf } from '../src/main/services/knownHosts'

const dir = mkdtempSync(path.join(tmpdir(), 'stratum-known-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** SSH wire-format public key blob: uint32 length, algorithm name, key bytes. */
function blob(type: string, fill: number): Buffer {
  const t = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(t.length)
  return Buffer.concat([len, t, Buffer.alloc(32, fill)])
}

const ed = (fill = 1) => blob('ssh-ed25519', fill)

describe('SSH known hosts (TOFU)', () => {
  it('reads the algorithm and prints an OpenSSH-style fingerprint', () => {
    expect(keyTypeOf(ed(1))).toBe('ssh-ed25519')
    expect(fingerprintOf(ed(1))).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    // Same bytes, same fingerprint; one changed byte, different fingerprint.
    expect(fingerprintOf(ed(1))).toBe(fingerprintOf(ed(1)))
    expect(fingerprintOf(ed(2))).not.toBe(fingerprintOf(ed(1)))
    expect(hostId(' DB.Internal ', 5432)).toBe('db.internal:5432')
  })

  it('rejects malformed key blobs instead of recording garbage', async () => {
    expect(() => keyTypeOf(Buffer.from([0, 0, 0]))).toThrow(/truncated/)
    expect(() => keyTypeOf(Buffer.concat([Buffer.from([0, 0, 0, 200]), Buffer.alloc(4)]))).toThrow(/invalid type/)
    const store = new KnownHosts(path.join(dir, 'bad-blob.json'))
    await expect(store.verify('h', 22, Buffer.from('nope'))).rejects.toThrow(/truncated/)
  })

  it('records an unknown key once and accepts it on the next connection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const file = path.join(dir, 'tofu.json')
    const store = new KnownHosts(file)
    const first = await store.verify('server.example', 22, ed(1))
    expect(first).toMatchObject({ added: true, type: 'ssh-ed25519' })
    const second = await store.verify('server.example', 22, ed(1))
    expect(second.added).toBe(false)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved.hosts['server.example:22']).toHaveLength(1)
    // A second constructor (next app start) sees the same trust.
    expect(await new KnownHosts(file).verify('server.example', 22, ed(1))).toMatchObject({ added: false })
    warn.mockRestore()
  })

  it('rejects a changed key for the same host and algorithm, naming both fingerprints', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = new KnownHosts(path.join(dir, 'mismatch.json'))
    await store.verify('server.example', 22, ed(1))
    await expect(store.verify('server.example', 22, ed(2))).rejects.toThrow(/host key verification failed/i)
    const message = await store.verify('server.example', 22, ed(2)).catch((e: Error) => e.message)
    expect(message).toContain(fingerprintOf(ed(1)))
    expect(message).toContain(fingerprintOf(ed(2)))
    // Different port is a different host entry, as in OpenSSH.
    expect(await store.verify('server.example', 2222, ed(2))).toMatchObject({ added: true })
  })

  it('forgets a host on request and fails closed on a corrupt file', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const file = path.join(dir, 'forget.json')
    const store = new KnownHosts(file)
    await store.verify('h', 22, ed(1))
    await store.forget('h', 22)
    expect(await store.list()).toEqual({})
    expect(await store.verify('h', 22, ed(2))).toMatchObject({ added: true })

    const corrupt = path.join(dir, 'corrupt.json')
    const fs = await import('node:fs')
    fs.writeFileSync(corrupt, '{ broken')
    await expect(new KnownHosts(corrupt).verify('h', 22, ed(1))).rejects.toThrow(/not valid JSON/)
  })

  it('serialises concurrent first connections so both see one entry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const file = path.join(dir, 'concurrent.json')
    const store = new KnownHosts(file)
    const results = await Promise.all([store.verify('h', 22, ed(1)), store.verify('h', 22, ed(1))])
    expect(results.map((r) => r.added).sort()).toEqual([false, true])
    expect(JSON.parse(readFileSync(file, 'utf8')).hosts['h:22']).toHaveLength(1)
  })
})
