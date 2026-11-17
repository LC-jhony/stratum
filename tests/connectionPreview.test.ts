import { describe, expect, it } from 'vitest'
import { connectionPreview, redactSecrets } from '../src/core/connectionPreview'
import type { ConnectionConfig } from '../src/shared/types'

const base: ConnectionConfig = { id: 'c1', name: 'Local', kind: 'postgres', host: 'db.internal', port: 5432, user: 'ana', database: 'shop' }

describe('connection preview', () => {
  it('builds a PostgreSQL URL without ever including a password', () => {
    const preview = connectionPreview({ ...base, password: 'hunter2' })
    expect(preview.text).toBe('postgresql://ana@db.internal:5432/shop')
    expect(preview.text).not.toContain('hunter2')
  })

  it('adds the SSL mode PostgreSQL and MySQL understand', () => {
    expect(connectionPreview({ ...base, ssl: true }).text).toContain('?sslmode=require')
    expect(connectionPreview({ ...base, ssl: true, sslVerify: true }).text).toContain('?sslmode=verify-full')
    expect(connectionPreview({ ...base, kind: 'mysql', port: 3306, ssl: true }).text).toBe('mysql://ana@db.internal:3306/shop?ssl-mode=REQUIRED')
  })

  it('shows sockets, SQLite files and the in-memory database verbatim', () => {
    expect(connectionPreview({ ...base, kind: 'mysql', socketPath: '/run/mysqld.sock' }).text).toBe('mysql+unix:///run/mysqld.sock/shop')
    expect(connectionPreview({ ...base, kind: 'postgres', socketPath: '/var/run/postgresql' }).text).toBe('postgresql:///shop?host=%2Fvar%2Frun%2Fpostgresql')
    expect(connectionPreview({ ...base, kind: 'sqlite', filePath: '/tmp/test.db' }).text).toBe('sqlite:/tmp/test.db')
    expect(connectionPreview({ ...base, kind: 'sqlite', filePath: ':memory:' }).text).toBe('sqlite::memory:')
  })

  it('redacts passwords in a MongoDB URI and secret query parameters', () => {
    const preview = connectionPreview({ ...base, kind: 'mongodb', uri: 'mongodb://ana:secret@mongo:27017/shop?authSource=admin' })
    expect(preview.text).toBe('mongodb://ana:•••@mongo:27017/shop?authSource=admin')
    expect(preview.text).not.toContain('secret')
  })

  it('redacts JDBC URLs with password parameters and URL user-info', () => {
    expect(redactSecrets('jdbc:postgresql://ana:secret@db:5432/shop?password=other&user=ana')).toBe(
      'jdbc:postgresql://ana:•••@db:5432/shop?password=•••&user=ana',
    )
    expect(connectionPreview({ ...base, kind: 'jdbc', jdbc: { url: 'jdbc:mysql://u:secret@h:3306/db', driverPath: '/x.jar', dialect: 'mysql' } }).text)
      .toBe('jdbc:mysql://u:•••@h:3306/db')
  })

  it('summarizes the network helper without credentials', () => {
    expect(connectionPreview({ ...base, ssh: { enabled: true, host: 'jump', port: 2222, user: 'ops', password: 'secret' } }).helper)
      .toBe('SSH ops@jump:2222')
    expect(connectionPreview({ ...base, proxy: { enabled: true, type: 'socks5', host: 'proxy', port: 1080, password: 'secret' } }).helper)
      .toBe('SOCKS5 proxy proxy:1080')
  })

  it('brackets IPv6 hosts and encodes user/database names', () => {
    const preview = connectionPreview({ ...base, host: '::1', user: 'ana maria', database: 'my db' })
    expect(preview.text).toBe('postgresql://ana%20maria@[::1]:5432/my%20db')
  })
})
