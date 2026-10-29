import { createServer, type Server } from 'node:http'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { JDBC_PORT, JdbcSidecar } from '../src/main/services/jdbcSidecar'

const dir = mkdtempSync(path.join(tmpdir(), 'stratum-jdbc-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const servers: Server[] = []
afterAll(() => { for (const s of servers) s.close() })

/** A fake adapter (or any HTTP program) on an ephemeral loopback port. */
async function serve(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

const freePort = async (): Promise<number> => {
  const port = await serve(() => undefined)
  const server = servers.pop()!
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe('JDBC sidecar lifecycle', () => {
  it('reuses an already running adapter instead of spawning Java', async () => {
    const port = await serve((req, res) => {
      res.writeHead(req.url === '/test' ? 200 : 404, { 'content-type': 'application/json' })
      res.end(JSON.stringify('hello'))
    })
    const sidecar = new JdbcSidecar(() => ({ jar: '/does/not/exist.jar' }), { port })
    await expect(sidecar.ensureRunning()).resolves.toBeUndefined()
    sidecar.stop()
  })

  it('reports a foreign program holding the port instead of talking to it', async () => {
    const port = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>some other server</h1>') })
    const sidecar = new JdbcSidecar(() => ({ jar: '/does/not/exist.jar' }), { port })
    await expect(sidecar.ensureRunning()).rejects.toThrow(/already in use by another program/)
    sidecar.stop()
  })

  it('fails fast when the adapter JAR is missing', async () => {
    const port = await freePort()
    const sidecar = new JdbcSidecar(() => ({ jar: '/does/not/exist.jar' }), { port })
    await expect(sidecar.ensureRunning()).rejects.toThrow(/jdbc-adapter-server\.jar not found/)
    sidecar.stop()
  })

  it.skipIf(process.platform === 'win32')('surfaces the JVM stderr when the adapter dies during startup', async () => {
    const port = await freePort()
    const jar = path.join(dir, 'bad.jar')
    writeFileSync(jar, 'not a jar')
    const home = path.join(dir, 'jdk')
    const bin = path.join(home, 'bin')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(bin, { recursive: true })
    const java = path.join(bin, 'java')
    writeFileSync(java, '#!/bin/sh\necho "Error: Invalid or corrupt jarfile $2" >&2\nexit 1\n')
    chmodSync(java, 0o755)
    const sidecar = new JdbcSidecar(() => ({ jar, javaHome: home }), { port, timeouts: { start: 2000 } })
    await expect(sidecar.ensureRunning()).rejects.toThrow(/stopped during startup.*Invalid or corrupt jarfile/s)
    sidecar.stop()
  }, 15000)

  it('turns a hung request into a timeout that names the endpoint', async () => {
    const port = await serve((_req, _res) => { /* never answers */ })
    const sidecar = new JdbcSidecar(() => ({}), { port, timeouts: { test: 120 } })
    await expect(sidecar.post('alive', { id: 'x' })).rejects.toThrow(/did not answer alive within/)
    sidecar.stop()
  })

  it('reports a non-JSON answer as a port conflict', async () => {
    const port = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('OK') })
    const sidecar = new JdbcSidecar(() => ({}), { port })
    await expect(sidecar.post('test', {})).rejects.toThrow(/non-JSON response/)
    sidecar.stop()
  })

  it('includes the HTTP status and body in adapter errors', async () => {
    const port = await serve((_req, res) => { res.writeHead(500); res.end('boom') })
    const sidecar = new JdbcSidecar(() => ({}), { port })
    await expect(sidecar.post('connect', {})).rejects.toThrow(/HTTP 500 — boom/)
    sidecar.stop()
  })

  it('keeps the documented default port', () => {
    expect(JDBC_PORT).toBe(7823)
  })
})
