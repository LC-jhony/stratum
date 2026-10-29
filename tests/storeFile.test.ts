import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

import { JsonStore, seal } from '../src/main/services/store'

const dir = mkdtempSync(path.join(tmpdir(), 'stratum-store-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('JsonStore durability', () => {
  it('starts from defaults when the file does not exist yet', async () => {
    const store = new JsonStore(path.join(dir, 'missing.json'), { connections: [] as unknown[] })
    expect(await store.read()).toEqual({ connections: [] })
  })

  it('backs up a corrupt file before resetting to defaults', async () => {
    const file = path.join(dir, 'broken.json')
    writeFileSync(file, '{ not json')
    const store = new JsonStore(file, { queries: {} as Record<string, string[]> })
    expect(await store.read()).toEqual({ queries: {} })
    const backups = readdirSync(dir).filter((f) => f.startsWith('broken.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(path.join(dir, backups[0]), 'utf8')).toBe('{ not json')
  })

  it('refuses to reset when the file cannot be read at all', async () => {
    const file = path.join(dir, 'a-directory')
    const fs = await import('node:fs')
    fs.mkdirSync(file)
    const store = new JsonStore(file, { connections: [] as unknown[] })
    await expect(store.read()).rejects.toThrow()
  })

  it('writes atomically through a temp file and leaves no leftovers', async () => {
    const file = path.join(dir, 'atomic.json')
    const store = new JsonStore(file, { connections: [] as unknown[] })
    await store.write({ connections: [{ id: 'x' }] })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ connections: [{ id: 'x' }] })
    expect(readdirSync(dir).filter((f) => f.startsWith('atomic.json.') && f.endsWith('.tmp'))).toEqual([])
  })

  it('warns once, and stores plain text, when safeStorage is unavailable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(seal('secret')).toBe('secret')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
