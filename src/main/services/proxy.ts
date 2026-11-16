/**
 * Proxy helper: a local TCP listener that carries every database socket through a SOCKS5 or HTTP
 * CONNECT proxy. Like the SSH tunnel it is a connection helper, not a data source: the session
 * runs against a rewritten copy of the ConnectionConfig whose address is 127.0.0.1:<local port>,
 * so transports stay unaware that a proxy exists.
 *
 * One listener is kept per data source id, refcounted and promise-deduplicated exactly like the
 * SSH tunnel. Each accepted socket opens its own proxy connection (one CONNECT per database
 * socket), which is what a proxy expects; nothing is multiplexed.
 *
 * The SSH tunnel and this helper are mutually exclusive in this build: chaining them would need a
 * second address rewrite and is not part of the supported matrix.
 */
import net from 'node:net'
import { logger } from '../logger'
import type { ConnectionConfig, ProxyConfig } from '../../shared/types'
import { rewriteForTunnel, tunnelTarget, type TunnelTarget } from './sshTunnel'

export interface ProxyHandle {
  config: ConnectionConfig
  release: () => void
}

export const DEFAULT_PROXY_PORT: Record<ProxyConfig['type'], number> = { socks5: 1080, http: 3128 }
export const PROXY_TIMEOUT_MS = 15_000

interface ProxyListener {
  server: net.Server
  localPort: number
  target: TunnelTarget
  /** Live client sockets, so a torn-down listener never leaves half-open connections. */
  sockets: Set<net.Socket>
  refs: number
}

/** Keyed by data source id, so a listener survives session re-opens and test runs stay separate. */
const listeners = new Map<string, Promise<ProxyListener>>()

/** The proxy endpoint a config points at; throws actionable messages for an incomplete form. */
export function proxyEndpoint(proxy: ProxyConfig | undefined): { host: string; port: number } {
  if (!proxy?.enabled) throw new Error('The proxy is not enabled.')
  const host = proxy.host?.trim()
  if (!host) throw new Error('Set the proxy host before enabling the proxy.')
  const port = proxy.port ?? DEFAULT_PROXY_PORT[proxy.type]
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('The proxy port must be between 1 and 65535.')
  return { host, port }
}

export async function acquireProxy(cfg: ConnectionConfig): Promise<ProxyHandle> {
  const proxy = cfg.proxy
  if (!proxy?.enabled) return { config: cfg, release: () => undefined }
  if (cfg.ssh?.enabled) throw new Error('This data source has both an SSH tunnel and a proxy enabled; disable one of them.')
  const endpoint = proxyEndpoint(proxy)
  const target = tunnelTarget(cfg, 'proxy')
  const listener = await getListener(cfg.id, proxy, endpoint, target)
  listener.refs++
  let released = false
  return {
    config: rewriteForTunnel(cfg, listener.localPort),
    release: () => {
      if (released) return
      released = true
      listener.refs--
      if (listener.refs <= 0) {
        listeners.delete(cfg.id)
        destroy(listener)
      }
    },
  }
}

function getListener(key: string, proxy: ProxyConfig, endpoint: { host: string; port: number }, target: TunnelTarget): Promise<ProxyListener> {
  const existing = listeners.get(key)
  if (existing) return existing
  const holder: { promise?: Promise<ProxyListener> } = {}
  // Store the promise before awaiting so two concurrent opens share one listener. Drop the entry
  // as soon as the listener fails, so the next connect starts over instead of reusing an error.
  const drop = () => { if (holder.promise && listeners.get(key) === holder.promise) listeners.delete(key) }
  const created = createListener(proxy, endpoint, target, drop).catch((e) => { drop(); throw e })
  holder.promise = created
  listeners.set(key, created)
  return created
}

async function createListener(
  proxy: ProxyConfig,
  endpoint: { host: string; port: number },
  target: TunnelTarget,
  onClose: () => void,
): Promise<ProxyListener> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    void connectThroughProxy(proxy, endpoint, target)
      .then((upstream) => {
        socket.on('error', () => upstream.destroy())
        upstream.on('error', () => socket.destroy())
        upstream.on('close', () => socket.destroy())
        socket.on('close', () => upstream.destroy())
        socket.pipe(upstream).pipe(socket)
      })
      .catch((e: unknown) => {
        // The database client only sees a closed socket; the actionable reason is in the log and
        // in Settings → Test, which surfaces the same error before saving.
        logger.warn(`proxy ${endpoint.host}:${endpoint.port} to ${target.host}:${target.port}:`, e instanceof Error ? e.message : String(e))
        socket.destroy()
      })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
  } catch (e) {
    onClose()
    throw new Error(`Cannot start the local proxy listener: ${e instanceof Error ? e.message : String(e)}`)
  }
  const localPort = (server.address() as net.AddressInfo).port
  server.on('error', (e) => logger.warn(`proxy listener ${localPort}:`, e.message))
  return { server, localPort, target, sockets, refs: 0 }
}

/** Tears down the listener and every socket it still owns (last release / quit / failed open). */
function destroy(listener: ProxyListener) {
  listener.server.close()
  for (const socket of listener.sockets) socket.destroy()
  listener.sockets.clear()
}

/** Test/quit hook: closes every proxy listener regardless of outstanding references. */
export async function closeAllProxies(): Promise<void> {
  const open = [...listeners.values()]
  listeners.clear()
  const settled = await Promise.allSettled(open)
  for (const s of settled) if (s.status === 'fulfilled') destroy(s.value)
}

/* ------------------------------------------------------------------ handshake */

/** Buffered reader over a raw socket: reads exactly what the handshake needs and returns the rest. */
class HandshakeReader {
  private buffer: Buffer = Buffer.alloc(0)
  private pending?: { measure: (buf: Buffer) => number; resolve: (b: Buffer) => void; reject: (e: Error) => void }
  private failure?: Error
  private detached = false

  constructor(private readonly socket: net.Socket) {
    socket.on('data', this.onData)
    socket.once('error', this.onError)
    socket.once('close', this.onClose)
  }

  private onData = (chunk: Buffer) => {
    if (this.detached) return
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    this.pump()
  }
  private onError = (e: Error) => this.fail(e)
  private onClose = () => this.fail(new Error('The proxy closed the connection during the handshake.'))

  private fail(e: Error) {
    if (this.detached) return
    this.failure = this.failure ?? e
    const pending = this.pending
    this.pending = undefined
    pending?.reject(this.failure)
  }

  private pump() {
    const pending = this.pending
    if (!pending) return
    let size: number
    try { size = pending.measure(this.buffer) } catch (e) {
      this.pending = undefined
      pending.reject(e instanceof Error ? e : new Error(String(e)))
      return
    }
    if (size <= 0) return
    this.pending = undefined
    pending.resolve(this.consume(size))
  }

  private consume(size: number): Buffer {
    const head = this.buffer.subarray(0, size)
    this.buffer = this.buffer.subarray(size)
    return head
  }

  private wait(measure: (buf: Buffer) => number): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure)
    let size: number
    try { size = measure(this.buffer) } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)))
    }
    if (size > 0) return Promise.resolve(this.consume(size))
    return new Promise<Buffer>((resolve, reject) => { this.pending = { measure, resolve, reject } })
  }

  read(size: number): Promise<Buffer> { return this.wait((buf) => (buf.length >= size ? size : 0)) }

  readUntil(marker: Buffer, limit = 64 * 1024): Promise<Buffer> {
    return this.wait((buf) => {
      const at = buf.indexOf(marker)
      if (at >= 0) return at + marker.length
      if (buf.length > limit) throw new Error('The proxy sent an oversized response header.')
      return 0
    })
  }

  /** Detaches from the socket and returns whatever arrived beyond the handshake (early payload). */
  release(): Buffer {
    this.detached = true
    this.socket.removeListener('data', this.onData)
    this.socket.removeListener('error', this.onError)
    this.socket.removeListener('close', this.onClose)
    const rest = this.buffer
    this.buffer = Buffer.alloc(0)
    return rest
  }
}

/** Opens one TCP connection to the proxy and completes the tunnel to the database target. */
export async function connectThroughProxy(
  proxy: ProxyConfig,
  endpoint: { host: string; port: number },
  target: TunnelTarget,
): Promise<net.Socket> {
  const socket = await connectToProxy(endpoint)
  const reader = new HandshakeReader(socket)
  const onTimeout = () => socket.destroy(new Error(`The proxy did not answer within ${PROXY_TIMEOUT_MS / 1000} seconds.`))
  socket.setTimeout(PROXY_TIMEOUT_MS, onTimeout)
  try {
    if (proxy.type === 'socks5') await socksHandshake(socket, reader, proxy, target)
    else await httpHandshake(socket, reader, proxy, target)
    const rest = reader.release()
    socket.removeListener('timeout', onTimeout)
    socket.setTimeout(0)
    if (rest.length) socket.unshift(rest)
    // The caller pipes the socket right away; until then an error must not become unhandled.
    socket.on('error', () => socket.destroy())
    return socket
  } catch (e) {
    reader.release()
    socket.destroy()
    throw e instanceof Error ? e : new Error(String(e))
  }
}

function connectToProxy(endpoint: { host: string; port: number }): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ host: endpoint.host, port: endpoint.port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Cannot reach the proxy ${endpoint.host}:${endpoint.port}: timed out.`))
    }, PROXY_TIMEOUT_MS)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.removeListener('error', onError)
      resolve(socket)
    })
    const onError = (e: Error) => {
      clearTimeout(timer)
      socket.destroy()
      reject(new Error(`Cannot reach the proxy ${endpoint.host}:${endpoint.port}: ${e.message}`))
    }
    socket.once('error', onError)
  })
}

const SOCKS_ERRORS: Record<number, string> = {
  1: 'general SOCKS server failure',
  2: 'connection not allowed by the proxy rules',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported',
}

async function socksHandshake(socket: net.Socket, reader: HandshakeReader, proxy: ProxyConfig, target: TunnelTarget): Promise<void> {
  const wantsAuth = !!proxy.user || !!proxy.password
  // Offer no-auth too when a username is present: some proxies ignore credentials on allow-listed hosts.
  socket.write(Buffer.from(wantsAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]))
  const greeting = await reader.read(2)
  if (greeting[0] !== 0x05) throw new Error('The SOCKS proxy answered with an unsupported protocol version.')
  const method = greeting[1]
  if (method === 0xff) throw new Error('The SOCKS proxy rejected every authentication method offered.')
  if (method === 0x02) {
    const user = Buffer.from(proxy.user ?? '', 'utf8')
    const pass = Buffer.from(proxy.password ?? '', 'utf8')
    if (user.length > 255 || pass.length > 255) throw new Error('The SOCKS username and password must be at most 255 bytes each.')
    socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
    const auth = await reader.read(2)
    if (auth[0] !== 0x01 || auth[1] !== 0x00) throw new Error('The SOCKS proxy rejected the username or password.')
  } else if (method !== 0x00) {
    throw new Error(`The SOCKS proxy chose an unsupported authentication method (${method}).`)
  }

  const port = Buffer.alloc(2)
  port.writeUInt16BE(target.port)
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), socksAddress(target.host), port]))

  const head = await reader.read(4)
  if (head[0] !== 0x05 || head[1] !== 0x00) {
    if (head[0] === 0x05) throw new Error(`The SOCKS proxy cannot reach ${target.host}:${target.port}: ${SOCKS_ERRORS[head[1]] ?? `code ${head[1]}`}.`)
    throw new Error('The SOCKS proxy returned an invalid reply.')
  }
  // Consume BND.ADDR and BND.PORT so the next bytes belong to the database server.
  const atyp = head[3]
  if (atyp === 0x01) await reader.read(6)
  else if (atyp === 0x04) await reader.read(18)
  else if (atyp === 0x03) {
    const length = (await reader.read(1))[0]
    await reader.read(length + 2)
  } else throw new Error('The SOCKS proxy returned an unknown address type.')
}

/** SOCKS5 address field: IPv4, IPv6 or a domain name. */
function socksAddress(host: string): Buffer {
  const version = net.isIP(host)
  if (version === 4) return Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split('.').map((part) => Number(part)))])
  if (version === 6) return Buffer.concat([Buffer.from([0x04]), ipv6Bytes(host)])
  const name = Buffer.from(host, 'utf8')
  if (!name.length) throw new Error('The proxy target has no host.')
  if (name.length > 255) throw new Error('The server hostname is too long for SOCKS5.')
  return Buffer.concat([Buffer.from([0x03, name.length]), name])
}

/** Textual IPv6 to 16 bytes, including `::` compression, an embedded IPv4 tail and a zone id. */
export function ipv6Bytes(address: string): Buffer {
  const zone = address.indexOf('%')
  let text = (zone >= 0 ? address.slice(0, zone) : address).trim()
  const halves = text.split('::')
  if (halves.length > 2) throw new Error(`Invalid IPv6 address: ${address}`)
  const group = (part: string): number[] => {
    if (!part) return []
    const pieces = part.split(':')
    const out: number[] = []
    for (const [index, piece] of pieces.entries()) {
      if (piece.includes('.')) {
        // Embedded IPv4 is only legal in the last position and expands to two 16-bit groups.
        if (index !== pieces.length - 1) throw new Error(`Invalid IPv6 address: ${address}`)
        const octets = piece.split('.').map((o) => Number(o))
        if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) throw new Error(`Invalid IPv6 address: ${address}`)
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3])
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(piece)) throw new Error(`Invalid IPv6 address: ${address}`)
        out.push(Number.parseInt(piece, 16))
      }
    }
    return out
  }
  const head = group(halves[0])
  const tail = halves.length === 2 ? group(halves[1]) : []
  if (halves.length === 1 && head.length !== 8) throw new Error(`Invalid IPv6 address: ${address}`)
  const missing = 8 - head.length - tail.length
  if (missing < 0 || (halves.length === 2 && missing < 1)) throw new Error(`Invalid IPv6 address: ${address}`)
  const groups = halves.length === 2 ? [...head, ...Array<number>(missing).fill(0), ...tail] : head
  const bytes = Buffer.alloc(16)
  groups.forEach((value, index) => bytes.writeUInt16BE(value, index * 2))
  return bytes
}

async function httpHandshake(socket: net.Socket, reader: HandshakeReader, proxy: ProxyConfig, target: TunnelTarget): Promise<void> {
  const authority = net.isIPv6(target.host) ? `[${target.host}]:${target.port}` : `${target.host}:${target.port}`
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, 'Proxy-Connection: keep-alive']
  if (proxy.user || proxy.password) {
    lines.push(`Proxy-Authorization: Basic ${Buffer.from(`${proxy.user ?? ''}:${proxy.password ?? ''}`, 'utf8').toString('base64')}`)
  }
  lines.push('', '')
  socket.write(lines.join('\r\n'))

  const head = await reader.readUntil(Buffer.from('\r\n\r\n'))
  const text = head.subarray(0, head.length - 4).toString('latin1')
  const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/.exec(text.split('\r\n')[0] ?? '')
  if (!status) throw new Error('The HTTP proxy returned an invalid response.')
  const code = Number(status[1])
  if (code < 200 || code >= 300) {
    const reason = status[2]?.trim()
    throw new Error(`The HTTP proxy refused the tunnel to ${authority}: ${status[1]}${reason ? ` ${reason}` : ''}.`)
  }
}
