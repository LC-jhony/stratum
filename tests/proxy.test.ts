import { afterAll, describe, expect, it } from 'vitest'
import net from 'node:net'
import type { ConnectionConfig, ProxyConfig } from '../src/shared/types'
import { acquireProxy, closeAllProxies, connectThroughProxy, DEFAULT_PROXY_PORT, ipv6Bytes, proxyEndpoint } from '../src/main/services/proxy'
import { acquireTunnel, closeAllTunnels } from '../src/main/services/sshTunnel'

/**
 * Proxy helper: the address math is pure and the live halves run against an in-process SOCKS5 and
 * HTTP CONNECT server, so the test proves a database socket really travels through the proxy.
 */

const openServers: net.Server[] = []
const listen = (server: net.Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      openServers.push(server)
      resolve((server.address() as net.AddressInfo).port)
    })
  })

afterAll(async () => {
  await closeAllProxies()
  await closeAllTunnels()
  await Promise.all(openServers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
})

const cfg = (proxy: ProxyConfig, over: Partial<ConnectionConfig> = {}): ConnectionConfig =>
  ({ id: 'p1', name: 'proxy test', kind: 'postgres', host: '127.0.0.1', port: 5432, proxy, ...over })

const roundtrip = (port: number, message: string, timeoutMs = 5000): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('proxy roundtrip timed out')) }, timeoutMs)
    let data = ''
    socket.on('connect', () => socket.write(message))
    socket.on('data', (chunk) => { data += chunk.toString(); socket.end() })
    socket.on('close', () => { clearTimeout(timer); resolve(data) })
    socket.on('error', (e) => { clearTimeout(timer); reject(e) })
  })

const echoServer = (): net.Server => net.createServer((s) => s.pipe(s))

/* ------------------------------------------------------------------ fake proxies */

interface SocksOptions { user?: string; pass?: string }

/** Minimal SOCKS5 server: greeting, optional user/password, CONNECT and byte piping. */
function fakeSocks5(opts: SocksOptions = {}): net.Server {
  return net.createServer((client) => {
    let buf: Buffer = Buffer.alloc(0)
    let stage: 'greet' | 'auth' | 'req' | 'done' = 'greet'
    const pump = () => {
      for (;;) {
        if (stage === 'greet') {
          if (buf.length < 2) return
          const count = buf[1]
          if (buf.length < 2 + count) return
          const methods = [...buf.subarray(2, 2 + count)]
          buf = buf.subarray(2 + count)
          if (opts.user !== undefined) {
            if (!methods.includes(0x02)) { client.end(Buffer.from([0x05, 0xff])); return }
            client.write(Buffer.from([0x05, 0x02]))
            stage = 'auth'
          } else {
            client.write(Buffer.from([0x05, 0x00]))
            stage = 'req'
          }
          continue
        }
        if (stage === 'auth') {
          if (buf.length < 2) return
          const ulen = buf[1]
          if (buf.length < 3 + ulen) return
          const plen = buf[2 + ulen]
          if (buf.length < 3 + ulen + plen) return
          const user = buf.subarray(2, 2 + ulen).toString()
          const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString()
          buf = buf.subarray(3 + ulen + plen)
          if (user !== opts.user || pass !== opts.pass) { client.end(Buffer.from([0x01, 0x01])); return }
          client.write(Buffer.from([0x01, 0x00]))
          stage = 'req'
          continue
        }
        if (stage === 'req') {
          if (buf.length < 4) return
          const atyp = buf[3]
          let host: string
          let offset: number
          if (atyp === 0x01) {
            if (buf.length < 10) return
            host = [...buf.subarray(4, 8)].join('.')
            offset = 8
          } else if (atyp === 0x03) {
            if (buf.length < 5) return
            const len = buf[4]
            if (buf.length < 5 + len + 2) return
            host = buf.subarray(5, 5 + len).toString()
            offset = 5 + len
          } else {
            client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
            return
          }
          const port = buf.readUInt16BE(offset)
          buf = buf.subarray(offset + 2)
          const upstream = net.connect(port, host)
          upstream.once('connect', () => {
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
            stage = 'done'
            if (buf.length) upstream.write(buf)
            buf = Buffer.alloc(0)
            client.pipe(upstream).pipe(client)
          })
          upstream.on('error', () => client.destroy())
          return
        }
        return
      }
    }
    client.on('data', (chunk) => { if (stage === 'done') return; buf = Buffer.concat([buf, chunk]); pump() })
    client.on('error', () => undefined)
  })
}

/** Minimal HTTP proxy: parses one CONNECT, optionally demands Basic auth, then pipes. */
function fakeHttpProxy(opts: { auth?: string; status?: number } = {}): net.Server {
  return net.createServer((client) => {
    let text = ''
    const onData = (chunk: Buffer) => {
      text += chunk.toString('latin1')
      const end = text.indexOf('\r\n\r\n')
      if (end < 0) return
      client.removeListener('data', onData)
      const head = text.slice(0, end)
      const rest = Buffer.from(text.slice(end + 4), 'latin1')
      const match = /^CONNECT\s+(\[[^\]]+\]|[^:\s]+):(\d+)\s+HTTP\/1\.[01]\s*$/im.exec(head)
      if (!match) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return }
      if (opts.status && opts.status !== 200) { client.end(`HTTP/1.1 ${opts.status} Nope\r\n\r\n`); return }
      if (opts.auth && !head.toLowerCase().includes(`proxy-authorization: basic ${opts.auth.toLowerCase()}`)) {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
        return
      }
      const host = match[1].replace(/^\[|\]$/g, '')
      const upstream = net.connect(Number(match[2]), host)
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n')
        if (rest.length) upstream.write(rest)
        client.pipe(upstream).pipe(client)
      })
      upstream.on('error', () => client.destroy())
    }
    client.on('data', onData)
    client.on('error', () => undefined)
  })
}

/* ------------------------------------------------------------------ pure rules */

describe('proxyEndpoint', () => {
  it('defaults the port per protocol and trims the host', () => {
    expect(proxyEndpoint({ enabled: true, type: 'socks5', host: ' 127.0.0.1 ' })).toEqual({ host: '127.0.0.1', port: DEFAULT_PROXY_PORT.socks5 })
    expect(proxyEndpoint({ enabled: true, type: 'http', host: 'proxy.internal' }).port).toBe(DEFAULT_PROXY_PORT.http)
  })

  it('rejects a missing host, an invalid port and a disabled helper', () => {
    expect(() => proxyEndpoint({ enabled: false, type: 'http' })).toThrow(/not enabled/)
    expect(() => proxyEndpoint({ enabled: true, type: 'http' })).toThrow(/proxy host/)
    expect(() => proxyEndpoint({ enabled: true, type: 'http', host: 'h', port: 0 })).toThrow(/between 1 and 65535/)
  })
})

describe('ipv6Bytes', () => {
  it('expands :: and an embedded IPv4 tail', () => {
    expect(ipv6Bytes('::1')).toEqual(Buffer.from('00000000000000000000000000000001', 'hex'))
    expect(ipv6Bytes('::ffff:192.168.0.1')).toEqual(Buffer.from('00000000000000000000ffffc0a80001', 'hex'))
    expect(ipv6Bytes('2001:db8::ff00:42:8329')).toEqual(Buffer.from('20010db8000000000000ff0000428329', 'hex'))
  })

  it('rejects malformed addresses', () => {
    expect(() => ipv6Bytes('2001:db8::1::2')).toThrow(/Invalid IPv6/)
    expect(() => ipv6Bytes('12345::1')).toThrow(/Invalid IPv6/)
  })
})

describe('helper composition', () => {
  it('refuses to combine an SSH tunnel with a proxy', async () => {
    const proxy: ProxyConfig = { enabled: true, type: 'socks5', host: '127.0.0.1', port: 1080 }
    const ssh = { enabled: true, host: 'jump.internal', user: 'root', authType: 'password' as const, password: 'x' }
    await expect(acquireProxy(cfg(proxy, { ssh }))).rejects.toThrow(/both an SSH tunnel and a proxy/)
    await expect(acquireTunnel(cfg(proxy, { ssh }))).rejects.toThrow(/both an SSH tunnel and a proxy/)
  })

  it('rejects a proxy on a local file and an unreachable proxy with actionable text', async () => {
    const proxy: ProxyConfig = { enabled: true, type: 'http', host: '127.0.0.1', port: 9 }
    await expect(acquireProxy(cfg(proxy, { kind: 'sqlite', host: undefined, filePath: '/tmp/a.db' }))).rejects.toThrow(/local file/)
    await expect(acquireProxy(cfg(proxy, { host: '' }))).rejects.toThrow(/Set the server host/)
    await expect(connectThroughProxy(proxy, { host: '127.0.0.1', port: 1 }, { host: '127.0.0.1', port: 1 })).rejects.toThrow(/Cannot reach the proxy/)
  }, 20000)
})

/* ------------------------------------------------------------------ live SOCKS5 */

describe('SOCKS5 forwarding', () => {
  it('carries bytes, shares one listener per data source and closes with the last release', async () => {
    const echo = echoServer()
    const echoPort = await listen(echo)
    const socksPort = await listen(fakeSocks5())
    const proxy: ProxyConfig = { enabled: true, type: 'socks5', host: '127.0.0.1', port: socksPort }
    const first = await acquireProxy(cfg(proxy, { port: echoPort }))
    const second = await acquireProxy(cfg(proxy, { port: echoPort }))
    try {
      expect(first.config.host).toBe('127.0.0.1')
      expect(first.config.port).not.toBe(echoPort)
      expect(await roundtrip(first.config.port!, 'hola')).toBe('hola')
      expect(second.config.port).toBe(first.config.port)
      first.release()
      expect(await roundtrip(second.config.port!, 'sigue')).toBe('sigue')
    } finally {
      first.release()
      second.release()
    }
    await expect(roundtrip(first.config.port!, 'nadie', 500)).rejects.toBeTruthy()
  }, 20000)

  it('authenticates with username and password', async () => {
    const echo = echoServer()
    const echoPort = await listen(echo)
    const socksPort = await listen(fakeSocks5({ user: 'ana', pass: 's3cret' }))
    const proxy: ProxyConfig = { enabled: true, type: 'socks5', host: '127.0.0.1', port: socksPort, user: 'ana', password: 's3cret' }
    const handle = await acquireProxy(cfg(proxy, { port: echoPort }))
    try {
      expect(await roundtrip(handle.config.port!, 'auth')).toBe('auth')
    } finally {
      handle.release()
    }
  }, 20000)

  it('surfaces bad credentials instead of silently connecting', async () => {
    const socksPort = await listen(fakeSocks5({ user: 'ana', pass: 'right' }))
    const proxy: ProxyConfig = { enabled: true, type: 'socks5', host: '127.0.0.1', port: socksPort, user: 'ana', password: 'wrong' }
    await expect(connectThroughProxy(proxy, { host: '127.0.0.1', port: socksPort }, { host: '127.0.0.1', port: 80 }))
      .rejects.toThrow(/rejected the username or password/)
  }, 20000)
})

/* ------------------------------------------------------------------ live HTTP CONNECT */

describe('HTTP CONNECT forwarding', () => {
  it('opens the tunnel with basic auth when credentials are present', async () => {
    const echo = echoServer()
    const echoPort = await listen(echo)
    const authorization = Buffer.from('ana:s3cret').toString('base64')
    const httpPort = await listen(fakeHttpProxy({ auth: authorization }))
    const proxy: ProxyConfig = { enabled: true, type: 'http', host: '127.0.0.1', port: httpPort, user: 'ana', password: 's3cret' }
    const handle = await acquireProxy(cfg(proxy, { port: echoPort }))
    try {
      expect(await roundtrip(handle.config.port!, 'http')).toBe('http')
    } finally {
      handle.release()
    }
  }, 20000)

  it('reports a refused or unauthorized tunnel', async () => {
    const httpPort = await listen(fakeHttpProxy({ auth: 'c29tZTpvdGhlcg==' }))
    const proxy: ProxyConfig = { enabled: true, type: 'http', host: '127.0.0.1', port: httpPort }
    await expect(connectThroughProxy(proxy, { host: '127.0.0.1', port: httpPort }, { host: '127.0.0.1', port: 80 }))
      .rejects.toThrow(/refused the tunnel.*407/)
    const badPort = await listen(fakeHttpProxy({ status: 502 }))
    await expect(connectThroughProxy({ ...proxy, port: badPort }, { host: '127.0.0.1', port: badPort }, { host: '127.0.0.1', port: 80 }))
      .rejects.toThrow(/refused the tunnel.*502/)
  }, 20000)
})
