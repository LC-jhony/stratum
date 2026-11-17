import { describe, expect, it } from 'vitest'
import { classifyConnectionError, driverLabel } from '../src/core/diagnostics'

describe('connection failure classification', () => {
  it('recognizes DNS, refused, timeout and TLS errors', () => {
    expect(classifyConnectionError('getaddrinfo ENOTFOUND db.invalid').code).toBe('dns')
    expect(classifyConnectionError('connect ECONNREFUSED 127.0.0.1:5432').code).toBe('refused')
    expect(classifyConnectionError('Connection terminated due to connection timeout').code).toBe('timeout')
    expect(classifyConnectionError('self-signed certificate in certificate chain').code).toBe('tls')
  })

  it('recognizes authentication and missing database errors before generic words', () => {
    expect(classifyConnectionError('password authentication failed for user "ana"').code).toBe('auth')
    expect(classifyConnectionError('Access denied for user \'ana\'@\'localhost\' (using password: YES)').code).toBe('auth')
    expect(classifyConnectionError('database "shop" does not exist').code).toBe('database')
    expect(classifyConnectionError('Unknown database \'shop\'').code).toBe('database')
  })

  it('recognizes driver, SQLite file and session bootstrap failures', () => {
    expect(classifyConnectionError('No suitable driver found for jdbc:postgresql://db').code).toBe('driver')
    expect(classifyConnectionError('SQLITE_CANTOPEN: unable to open database file').code).toBe('file')
    expect(classifyConnectionError('Session setup failed: relation "nope" does not exist').code).toBe('bootstrap')
    expect(classifyConnectionError('Keep-alive validation failed').stage).toBe('unknown')
  })

  it('lets the known helper stage win over words in the driver message', () => {
    expect(classifyConnectionError('All configured authentication methods failed', 'tunnel')).toEqual(
      expect.objectContaining({ code: 'tunnel', stage: 'tunnel' }),
    )
    expect(classifyConnectionError('connect ECONNREFUSED 10.0.0.2:1080', 'proxy')).toEqual(
      expect.objectContaining({ code: 'proxy', stage: 'proxy' }),
    )
  })

  it('always returns an actionable hint', () => {
    for (const message of ['boom', '', 'getaddrinfo ENOTFOUND x', 'password authentication failed']) {
      expect(classifyConnectionError(message).hint.length).toBeGreaterThan(20)
    }
  })
})

describe('driver labels', () => {
  it('names the concrete driver for each family', () => {
    expect(driverLabel({ kind: 'postgres' })).toBe('pg')
    expect(driverLabel({ kind: 'mysql' })).toBe('mysql2')
    expect(driverLabel({ kind: 'jdbc', jdbc: { url: 'jdbc:x', driverPath: '/x.jar', dialect: 'postgres', driverClass: 'org.postgresql.Driver' } }))
      .toBe('JDBC · Driver')
    expect(driverLabel({ kind: 'jdbc' })).toBe('JDBC adapter')
  })
})
