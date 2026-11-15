import { describe, expect, it } from 'vitest'
import {
  CONNECTION_EXPORT_FORMAT, CONNECTION_EXPORT_VERSION, exportConnections, parseConnections, prepareImport,
  sanitizeConnection, uniqueConnectionName,
} from '../src/core/connectionTransfer'
import type { ConnectionConfig } from '../src/shared/types'

const base = (patch: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: 'c1', name: 'production', kind: 'postgres', host: 'db.example.com', port: 5432, user: 'alice',
  password: 'hunter2', database: 'app', ssl: true, sslKeyPassphrase: 'key-secret',
  profile: 'prod', color: 'red', confirmWrites: true,
  session: { initSql: 'set search_path to app', autoCommit: false, keepAliveSeconds: 30 },
  variables: { tenant: 'acme' },
  ssh: {
    enabled: true, host: 'jump.example.com', port: 22, user: 'bob', password: 'ssh-secret', passphrase: 'ssh-pass',
    privateKeyPath: '/home/bob/.ssh/id_ed25519',
    jumpHosts: [{ id: 'j1', host: 'inner.example.com', user: 'carol', password: 'jump-secret', passphrase: 'jump-pass' }],
  },
  ...patch,
})

describe('sanitizeConnection', () => {
  it('keeps the portable fields and removes every secret', () => {
    const { connection } = sanitizeConnection(base())
    expect(connection).toMatchObject({
      id: 'c1', name: 'production', kind: 'postgres', host: 'db.example.com', port: 5432, user: 'alice',
      database: 'app', ssl: true, profile: 'prod', color: 'red', confirmWrites: true,
      session: { initSql: 'set search_path to app', autoCommit: false, keepAliveSeconds: 30 },
      variables: { tenant: 'acme' },
      ssh: { enabled: true, host: 'jump.example.com', user: 'bob', privateKeyPath: '/home/bob/.ssh/id_ed25519' },
    })
    expect(connection).not.toHaveProperty('password')
    expect(connection).not.toHaveProperty('sslKeyPassphrase')
    expect(connection?.ssh).not.toHaveProperty('password')
    expect(connection?.ssh).not.toHaveProperty('passphrase')
    expect(connection?.ssh?.jumpHosts?.[0]).not.toHaveProperty('password')
    expect(connection?.ssh?.jumpHosts?.[0]).not.toHaveProperty('passphrase')
  })

  it('drops renderer-only secret flags instead of exporting them', () => {
    const view = { ...base(), hasPassword: true, hasSslKeyPassphrase: true,
      ssh: { enabled: true, host: 'jump.example.com', hasPassword: true, hasPassphrase: true,
        jumpHosts: [{ id: 'j1', host: 'inner', user: 'carol', hasPassword: true }] } }
    const json = JSON.stringify(sanitizeConnection(view).connection)
    expect(json).not.toContain('hasPassword')
    expect(json).not.toContain('hasPassphrase')
    expect(json).not.toContain('hunter2')
  })

  it('rejects entries without a supported kind', () => {
    expect(sanitizeConnection({ name: 'x', kind: 'excel' }).connection).toBeUndefined()
    expect(sanitizeConnection({ name: 'x', kind: 'postgres' }, 3).connection).toBeDefined()
    expect(sanitizeConnection(null, 2).problems[0]).toContain('Entry 3')
  })

  it('infers a name and repairs invalid numbers instead of trusting them', () => {
    const { connection } = sanitizeConnection({ kind: 'postgres', host: 'db.local', port: 900_000, ssl: 'yes' })
    expect(connection?.name).toBe('db.local')
    expect(connection).not.toHaveProperty('port')
    expect(connection).not.toHaveProperty('ssl')
  })

  it('keeps a disabled SSH tunnel that still has a host', () => {
    const { connection } = sanitizeConnection({ kind: 'postgres', host: 'db', ssh: { enabled: false, host: 'jump', user: 'bob', password: 'x' } })
    expect(connection?.ssh).toEqual({ enabled: false, host: 'jump', user: 'bob' })
  })

  it('keeps a JDBC preset but warns when the URL is missing', () => {
    const missing = sanitizeConnection({ kind: 'jdbc', name: 'ora' })
    expect(missing.connection).toBeDefined()
    expect(missing.connection).not.toHaveProperty('jdbc')
    expect(missing.problems.join(' ')).toContain('without a JDBC URL')
    const full = sanitizeConnection({ kind: 'jdbc', name: 'ora', jdbc: { url: 'jdbc:oracle:thin:@//db:1521/X', driverPath: '/drivers/ojdbc11.jar', dialect: 'oracle', driverClass: 'oracle.jdbc.OracleDriver' } })
    expect(full.connection?.jdbc).toEqual({ url: 'jdbc:oracle:thin:@//db:1521/X', driverPath: '/drivers/ojdbc11.jar', dialect: 'oracle', driverClass: 'oracle.jdbc.OracleDriver' })
  })
})

describe('export and parse', () => {
  it('round-trips portable connections through a versioned document', () => {
    const text = exportConnections([base()], new Date('2026-01-02T03:04:05.000Z'))
    const doc = JSON.parse(text)
    expect(doc).toMatchObject({ format: CONNECTION_EXPORT_FORMAT, version: CONNECTION_EXPORT_VERSION, exportedAt: '2026-01-02T03:04:05.000Z' })
    const { connections, warnings } = parseConnections(text)
    expect(warnings).toEqual([])
    expect(connections).toHaveLength(1)
    expect(connections[0]).toMatchObject({ name: 'production', kind: 'postgres', host: 'db.example.com', variables: { tenant: 'acme' } })
    expect(connections[0].password).toBeUndefined()
  })

  it('accepts a bare array for hand-written files', () => {
    const { connections } = parseConnections(JSON.stringify([{ kind: 'sqlite', name: 'local', filePath: '/tmp/a.db' }]))
    expect(connections[0]).toMatchObject({ name: 'local', kind: 'sqlite', filePath: '/tmp/a.db' })
  })

  it('skips invalid entries but keeps the valid ones with warnings', () => {
    const { connections, warnings } = parseConnections(JSON.stringify({ connections: [{ kind: 'nope' }, { kind: 'mysql', name: 'ok' }] }))
    expect(connections.map((c) => c.name)).toEqual(['ok'])
    expect(warnings).toHaveLength(1)
  })

  it('rejects empty, malformed, unknown and future documents', () => {
    expect(() => parseConnections('  ')).toThrow('empty')
    expect(() => parseConnections('{ not json')).toThrow('not valid JSON')
    expect(() => parseConnections('{"format":"dbeaver","connections":[]}')).toThrow('Unknown connection file format')
    expect(() => parseConnections('{"connections":[]}')).toThrow('No connections found')
    expect(() => parseConnections('{"format":"stratum.connections","version":99,"connections":[{"kind":"postgres"}]}')).toThrow('format version 99')
    expect(() => parseConnections('[{"kind":"nope"}]')).toThrow('No valid connections')
    expect(() => parseConnections('{"connections":"x"}')).toThrow('does not contain a connection list')
  })

  it('never imports secrets even when the file carries them', () => {
    const { connections } = parseConnections(JSON.stringify([{
      kind: 'postgres', name: 'x', password: 'p', sslKeyPassphrase: 'k',
      ssh: { enabled: true, host: 'j', user: 'u', password: 'p', passphrase: 'q', jumpHosts: [{ id: 'j', host: 'h', user: 'u', password: 'z' }] },
    }]))
    const json = JSON.stringify(connections)
    expect(json).not.toContain('"password"')
    expect(json).not.toContain('"passphrase"')
    expect(connections[0].ssh?.jumpHosts?.[0]).toEqual({ id: 'j', host: 'h', user: 'u' })
  })
})

describe('import naming', () => {
  it('suffixes duplicate names case-insensitively', () => {
    expect(uniqueConnectionName('Shop', [])).toBe('Shop')
    expect(uniqueConnectionName('Shop', ['shop'])).toBe('Shop (2)')
    expect(uniqueConnectionName('Shop', ['shop', 'SHOP (2)'])).toBe('Shop (3)')
  })

  it('assigns fresh ids and unique names without mutating the parsed entry', () => {
    let n = 0
    const parsed = [{ ...base(), id: 'same' }, { ...base(), id: 'same', name: 'production' }]
    const imported = prepareImport(parsed, ['production'], () => `new-${++n}`)
    expect(imported.map((c) => [c.id, c.name])).toEqual([['new-1', 'production (2)'], ['new-2', 'production (3)']])
    expect(parsed[0].id).toBe('same')
  })
})
