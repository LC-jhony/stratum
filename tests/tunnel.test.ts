import { afterAll, describe, expect, it } from 'vitest'
import net from 'node:net'
import type { ConnectionConfig } from '../src/shared/types'
import { ConnectionManager } from '../src/main/services/connectionManager'
import { acquireTunnel, closeAllTunnels, rewriteForTunnel, sshConnectConfig, targetFromJdbc, tunnelTarget } from '../src/main/services/sshTunnel'
import type { ConnectionStore } from '../src/main/services/store'
import type { JdbcSidecar } from '../src/main/services/jdbcSidecar'
import { listen, startSshd } from './helpers/sshd'

/**
 * The SSH helper needs both halves tested: the pure address rewriting (a tunnel must point the
 * transport at 127.0.0.1 without losing credentials, database name or JDBC options) and a real
 * handshake against an in-process SSH server, which proves forwardOut actually moves bytes.
 */

const ssh = (over: Partial<NonNullable<ConnectionConfig['ssh']>> = {}): NonNullable<ConnectionConfig['ssh']> =>
  ({ enabled: true, host: 'ssh.example.com', user: 'root', authType: 'password', password: 's3cret', ...over })

const cfg = (over: Partial<ConnectionConfig> = {}): ConnectionConfig =>
  ({ id: 'c1', name: 'test', kind: 'postgres', host: 'db.internal', port: 5432, ...over })

afterAll(async () => { await closeAllTunnels() })

describe('tunnel target resolution', () => {
  it('reads host/port from plain network configs and falls back to the kind default port', () => {
    expect(tunnelTarget(cfg())).toEqual({ host: 'db.internal', port: 5432 })
    expect(tunnelTarget(cfg({ kind: 'mysql', port: undefined }))).toEqual({ host: 'db.internal', port: 3306 })
    expect(() => tunnelTarget(cfg({ host: '' }))).toThrow(/Set the server host/)
  })
  it('rejects file sources and unix sockets with actionable messages', () => {
    expect(() => tunnelTarget(cfg({ kind: 'sqlite', filePath: '/tmp/db' }))).toThrow(/local file/)
    expect(() => tunnelTarget(cfg({ socketPath: '/var/run/postgresql' }))).toThrow(/unix socket/)
  })
  it('reads mongodb uris, including credentials, database and options', () => {
    const t = tunnelTarget(cfg({ kind: 'mongodb', uri: 'mongodb://ana:p%40ss@mongo.internal/sales?authSource=admin' }))
    expect(t).toEqual({ host: 'mongo.internal', port: 27017 })
    const out = rewriteForTunnel(cfg({ kind: 'mongodb', uri: 'mongodb://ana:p%40ss@mongo.internal/sales?authSource=admin' }), 12345)
    const url = new URL(out.uri!)
    expect(url.hostname).toBe('127.0.0.1')
    expect(url.port).toBe('12345')
    expect(decodeURIComponent(url.username)).toBe('ana')
    expect(decodeURIComponent(url.password)).toBe('p@ss')
    expect(url.pathname).toBe('/sales')
    expect(url.searchParams.get('authSource')).toBe('admin')
  })
  it('refuses srv and multi-host URIs instead of guessing', () => {
    expect(() => tunnelTarget(cfg({ kind: 'mongodb', uri: 'mongodb+srv://a:b@cluster0.example.net/db' }))).toThrow(/\+srv/)
    expect(() => tunnelTarget(cfg({ kind: 'mongodb', uri: 'mongodb://h1:27017,h2:27017/db?replicaSet=rs' }))).toThrow(/several hosts/)
  })
  it('refuses a multi-broker Kafka list, which one tunnel cannot bridge', () => {
    expect(() => tunnelTarget(cfg({ kind: 'kafka', host: 'broker1:9092,broker2:9092', port: 9092 }))).toThrow(/one Kafka broker/)
    expect(tunnelTarget(cfg({ kind: 'kafka', host: 'broker1:9092', port: 9092 }))).toEqual({ host: 'broker1', port: 9092 })
    expect(tunnelTarget(cfg({ kind: 'kafka', host: 'broker1', port: undefined }))).toEqual({ host: 'broker1', port: 9092 })
  })
  it('understands the common JDBC URL shapes', () => {
    expect(targetFromJdbc('jdbc:mysql://db.internal:3306/app')).toEqual({ host: 'db.internal', port: 3306 })
    expect(targetFromJdbc('jdbc:postgresql://10.0.0.7:5432/app')).toEqual({ host: '10.0.0.7', port: 5432 })
    expect(targetFromJdbc('jdbc:sqlserver://db.internal:1433;databaseName=app;encrypt=false')).toEqual({ host: 'db.internal', port: 1433 })
    expect(targetFromJdbc('jdbc:oracle:thin:@//oracle.internal:1521/FREEPDB1')).toEqual({ host: 'oracle.internal', port: 1521 })
    expect(targetFromJdbc('jdbc:oracle:thin:@oracle.internal:1521:ORCL')).toEqual({ host: 'oracle.internal', port: 1521 })
    expect(targetFromJdbc('jdbc:oracle:thin:@tcp://oracle.internal:1521/FREEPDB1')).toEqual({ host: 'oracle.internal', port: 1521 })
    expect(() => targetFromJdbc('jdbc:h2:file:/data/app')).toThrow(/single host:port/)
  })
  it('rewrites JDBC URLs in place, keeping the rest of the string untouched', () => {
    const out = rewriteForTunnel(cfg({ kind: 'jdbc', jdbc: { url: 'jdbc:sqlserver://db.internal:1433;databaseName=app', driverPath: '/drv.jar', dialect: 'mssql' } }), 23456)
    expect(out.jdbc?.url).toBe('jdbc:sqlserver://127.0.0.1:23456;databaseName=app')
    expect(out.jdbc?.dialect).toBe('mssql')
    const ora = rewriteForTunnel(cfg({ kind: 'jdbc', jdbc: { url: 'jdbc:oracle:thin:@oracle.internal:1521:ORCL', driverPath: '/drv.jar', dialect: 'oracle' } }), 1)
    expect(ora.jdbc?.url).toBe('jdbc:oracle:thin:@127.0.0.1:1:ORCL')
  })
})

describe('ssh client configuration', () => {
  it('carries host, port, user and timeout into the ssh2 options', async () => {
    const conf = await sshConnectConfig(ssh({ port: 2222, connectTimeoutMs: 1500 }))
    expect(conf).toMatchObject({ host: 'ssh.example.com', port: 2222, username: 'root', password: 's3cret', readyTimeout: 1500 })
  })
  it('asks for exactly what the auth mode needs', async () => {
    await expect(sshConnectConfig(ssh({ host: '', user: 'r' }))).rejects.toThrow(/SSH host/)
    await expect(sshConnectConfig(ssh({ user: '' }))).rejects.toThrow(/SSH username/)
    await expect(sshConnectConfig(ssh({ authType: 'password', password: undefined }))).rejects.toThrow(/password is required/)
    await expect(sshConnectConfig(ssh({ authType: 'privateKey', privateKeyPath: '/missing/key' }))).rejects.toThrow(/not readable/)
  })
})

/* ------------------------------------------------------------------ live handshake */

function roundtrip(port: number, message: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('tunnel roundtrip timed out')) }, timeoutMs)
    let data = ''
    socket.on('connect', () => socket.write(message))
    socket.on('data', (chunk) => { data += chunk.toString(); socket.end() })
    socket.on('close', () => { clearTimeout(timer); resolve(data) })
    socket.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

describe('ssh tunnel over a real handshake', () => {
  it('forwards TCP bytes to the target, shares one tunnel per data source and closes with the last release', async () => {
    const echo = net.createServer((s) => s.pipe(s))
    const echoPort = await listen(echo)
    const sshd = startSshd('s3cret')
    const sshPort = await listen(sshd)
    const target = cfg({ id: 't-share', host: '127.0.0.1', port: echoPort, ssh: ssh({ host: '127.0.0.1', port: sshPort }) })

    const first = await acquireTunnel(target)
    const second = await acquireTunnel(target)
    try {
      expect(first.config.host).toBe('127.0.0.1')
      expect(first.config.port).not.toBe(echoPort)
      expect(await roundtrip(first.config.port!, 'hola')).toBe('hola')

      expect(second.config.port).toBe(first.config.port) // promise dedupe: same local port
      first.release()
      expect(await roundtrip(second.config.port!, 'sigue')).toBe('sigue') // still alive while referenced
    } finally {
      first.release()
      second.release()
    }

    // The last release closes the local listener: the old port refuses new sessions.
    await expect(roundtrip(first.config.port!, 'nadie', 500)).rejects.toBeTruthy()
    echo.close()
    sshd.close()
  }, 30000)

  it('surfaces authentication failures as a tunnel error — and test() reports them, never rejects', async () => {
    const sshd = startSshd('correct')
    const sshPort = await listen(sshd)
    const bad = cfg({ id: 'c2', host: '127.0.0.1', port: 1, ssh: ssh({ host: '127.0.0.1', port: sshPort, password: 'wrong' }) })
    await expect(acquireTunnel(bad)).rejects.toThrow(/SSH tunnel to .* failed/)
    const manager = new ConnectionManager({ get: async () => bad } as unknown as ConnectionStore, {} as JdbcSidecar)
    const r = await manager.test({ ...bad, id: 'c3' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/SSH tunnel/)
    sshd.close()
  }, 30000)
})
