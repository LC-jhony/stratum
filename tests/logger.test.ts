import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createLogger, redact, redactText } from '../src/main/logger'

const dir = mkdtempSync(path.join(tmpdir(), 'stratum-log-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('redaction', () => {
  it('masks credential-shaped keys recursively', () => {
    expect(redact({
      host: 'db.example.com',
      password: 'hunter2',
      nested: { ssh: { passphrase: 'secret', user: 'alice' }, token: 'abc' },
      list: [{ apiKey: 'k' }],
    })).toEqual({
      host: 'db.example.com',
      password: '[redacted]',
      nested: { ssh: { passphrase: '[redacted]', user: 'alice' }, token: '[redacted]' },
      list: [{ apiKey: '[redacted]' }],
    })
  })

  it('keeps ordinary values and turns Errors into structured entries', () => {
    expect(redact('plain')).toBe('plain')
    expect(redact(new Error('boom'))).toMatchObject({ name: 'Error', message: 'boom' })
  })

  it('survives circular objects and deep nesting', () => {
    const circular: Record<string, unknown> = { password: 'x' }
    circular.self = circular
    expect(JSON.stringify(redact(circular))).toContain('[circular]')
    let deep: Record<string, unknown> = { password: 'x' }
    for (let i = 0; i < 20; i++) deep = { deep }
    expect(JSON.stringify(redact(deep))).toContain('[depth-limit]')
  })

  it('masks credentials embedded in URLs and assignments', () => {
    expect(redactText('postgres://alice:hunter2@db:5432/app')).toBe('postgres://alice:[redacted]@db:5432/app')
    expect(redactText('token=abc123&user=alice')).toBe('token=[redacted]&user=alice')
    expect(redactText('password: topsecret')).toBe('password: [redacted]')
    expect(redactText('the token bucket is empty')).toBe('the token bucket is empty')
  })
})

describe('file logger', () => {
  it('writes timestamped lines with the child scope', () => {
    const file = path.join(dir, 'plain.log')
    const log = createLogger({ file, console: false, now: () => new Date('2026-01-02T03:04:05.000Z') })
    log.child('store').warn('could not read', { file: 'connections.json', password: 'nope' })
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('2026-01-02T03:04:05.000Z [WARN] [store] could not read {"file":"connections.json","password":"[redacted]"}')
  })

  it('rotates and keeps the configured number of backups', () => {
    const file = path.join(dir, 'rotate.log')
    const log = createLogger({ file, console: false, maxBytes: 160, backups: 2, now: () => new Date('2026-01-02T03:04:05.000Z') })
    for (let i = 0; i < 12; i++) log.info(`line ${i} ${'x'.repeat(40)}`)
    const files = readdirSync(dir).filter((f) => f.startsWith('rotate.log'))
    expect(files).toContain('rotate.log')
    expect(files).toContain('rotate.log.1')
    expect(files).toContain('rotate.log.2')
    expect(files).not.toContain('rotate.log.3')
    expect(readFileSync(file, 'utf8').length).toBeLessThanOrEqual(160)
  })

  it('does not throw when the directory cannot be created', () => {
    const blocker = path.join(dir, 'blocked')
    writeFileSync(blocker, 'a file, not a directory')
    expect(() => createLogger({ file: path.join(blocker, 'x', 'app.log'), console: false }).info('still safe')).not.toThrow()
  })
})
