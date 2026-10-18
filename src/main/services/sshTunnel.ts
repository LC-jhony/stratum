import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { Client, type ConnectConfig } from 'ssh2'
import { KINDS } from '../../core/kinds'
import type { ConnectionConfig, DriverKind, SshConfig } from '../../shared/types'

/**
 * SSH tunnel helper — DataGrip calls these "connection helpers": they are not data sources, they
 * are a transport shared by any network database. One SSH connection is kept per data source id.
 * A local net.Server bound to 127.0.0.1:0 accepts the database's TCP connections and forwards each
 * one with `client.forwardOut` to the real target, so the session afterwards runs against a
 * rewritten copy of the ConnectionConfig (host/port, mongodb-style URI or JDBC URL now point at
 * 127.0.0.1:<local port>). Transports stay unaware that SSH exists.
 *
 * Acquire/release are refcounted and promise-deduplicated: concurrent opens of the same data
 * source share one SSH connection and one local port, and the last release tears everything down
 * (DbSession.close() is the caller that releases).
 *
 * Host keys are accepted without checking known_hosts in this first iteration; the roadmap entry
 * is a hostVerifier backed by ~/.ssh/known_hosts (like DataGrip's "Known hosts" tab).
 */

export interface TunnelTarget { host: string; port: number }
export interface TunnelHandle { config: ConnectionConfig; release: () => void }

interface Tunnel {
  client: Client
  server: net.Server
  localPort: number
  /** Live handles; the tunnel is destroyed when the last one releases. */
  refs: number
}

/** Keyed by data source id, so the tunnel survives session re-opens and test runs stay separate. */
const tunnels = new Map<string, Promise<Tunnel>>()

/* ------------------------------------------------------------------ target resolution */

const schemeOf = (uri: string): string => (uri.match(/^([a-z][a-z0-9+.-]*):/i)?.[1] ?? '').toLowerCase()
const authorityOf = (uri: string): string => uri.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1] ?? ''

/** Prepares the SSH configuration for ssh2, resolving keys/agent from the chosen auth mode. */
export async function sshConnectConfig(ssh: SshConfig): Promise<ConnectConfig> {
  const host = ssh.host?.trim()
  const user = ssh.user?.trim()
  if (!host) throw new Error('SSH host is required.')
  if (!user) throw new Error('SSH username is required.')
  const auth = ssh.authType ?? 'auto'
  const conf: ConnectConfig = {
    host,
    port: ssh.port && ssh.port > 0 ? ssh.port : 22,
    username: user,
    readyTimeout: ssh.connectTimeoutMs && ssh.connectTimeoutMs > 0 ? ssh.connectTimeoutMs : 10_000,
    // Keepalive keeps NAT/firewall state alive between query bursts, like DataGrip does.
    keepaliveInterval: 30_000,
    keepaliveCountMax: 3,
  }
  const explicitKey = ssh.privateKeyPath?.trim()
  const keyPath = explicitKey ? expandHome(explicitKey) : auth === 'auto' ? await defaultKeyPath() : undefined
  if (keyPath) {
    try {
      conf.privateKey = await readFile(keyPath)
      if (ssh.passphrase) conf.passphrase = ssh.passphrase
    } catch (e) {
      if (auth === 'privateKey') throw new Error(`SSH private key is not readable: ${keyPath} (${e instanceof Error ? e.message : String(e)})`)
      // auto: a stale default key must not block password/agent auth.
    }
  } else if (auth === 'privateKey') throw new Error('SSH private key path is required for "Key" authentication.')
  if (ssh.password) conf.password = ssh.password
  if (auth === 'password' && !ssh.password) throw new Error('SSH password is required.')
  const agent = process.env.SSH_AUTH_SOCK
  if (auth === 'agent' || (auth === 'auto' && (agent || !conf.password && !conf.privateKey))) {
    if (agent) conf.agent = agent
    else if (auth === 'agent') throw new Error('SSH agent authentication needs SSH_AUTH_SOCK (no agent socket found).')
  }
  return conf
}

/** `~` expansion for user-typed key paths; everything else is used as-is. */
const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p)

/** First existing default key; `auto` auth offers it after password. */
async function defaultKeyPath(): Promise<string | undefined> {
  for (const name of ['id_ed25519', 'id_rsa', 'id_ecdsa']) {
    const p = path.join(homedir(), '.ssh', name)
    try { await readFile(p); return p } catch { /* not there: try the next */ }
  }
  return undefined
}

/**
 * Real server address behind a connection config — the host:port the tunnel forwards to.
 * Understands host/port fields, provider connection strings (mongodb://, redis://…) and JDBC URLs.
 */
export function tunnelTarget(cfg: ConnectionConfig): TunnelTarget {
  if (cfg.kind === 'sqlite') throw new Error('SQLite is a local file: an SSH tunnel does not apply.')
  if (cfg.socketPath?.trim()) throw new Error('A unix socket cannot be reached through an SSH tunnel; clear the socket path first.')
  const uri = cfg.uri?.trim()
  if (cfg.kind !== 'jdbc' && uri) return targetFromUri(uri, cfg.kind)
  if (cfg.kind === 'jdbc') return targetFromJdbc(cfg.jdbc?.url ?? '')
  const host = cfg.host?.trim()
  if (!host) throw new Error('Set the server host (or a connection string) before enabling the SSH tunnel.')
  if (cfg.kind === 'kafka' && host.includes(',')) throw new Error('The SSH tunnel bridges one Kafka broker; list a single bootstrap broker or connect directly.')
  // Kafka accepts host:port in the broker field; split it so the forward targets the real address.
  let targetHost = host
  let explicitPort: number | undefined
  if (cfg.kind === 'kafka') {
    const colon = host.lastIndexOf(':')
    const parsed = colon > 0 ? Number(host.slice(colon + 1)) : NaN
    if (Number.isFinite(parsed) && parsed > 0) {
      targetHost = host.slice(0, colon)
      explicitPort = parsed
    }
  }
  const port = explicitPort ?? (cfg.port && cfg.port > 0 ? cfg.port : KINDS[cfg.kind].defaultPort)
  if (!port) throw new Error('Set the server port before enabling the SSH tunnel.')
  return { host: targetHost, port }
}

function targetFromUri(uri: string, kind: DriverKind): TunnelTarget {
  const scheme = schemeOf(uri)
  if (scheme.endsWith('+srv')) throw new Error(`${scheme}:// resolves its hosts through DNS, which the SSH tunnel cannot forward; use a direct host:port.`)
  if (authorityOf(uri).includes(',')) throw new Error('The connection string lists several hosts; the SSH tunnel forwards to a single host:port.')
  let url: URL
  try { url = new URL(uri) } catch { throw new Error(`Cannot parse the connection string for the tunnel: ${uri}`) }
  if (!url.hostname) throw new Error('The connection string has no host to tunnel to.')
  const port = url.port ? Number(url.port) : KINDS[kind].defaultPort
  if (!port) throw new Error('The connection string has no port to tunnel to.')
  return { host: url.hostname, port }
}

/**
 * JDBC URLs addressed by host:port, including Oracle's `@host:port:SID` and `@//host:port/service`
 * shapes. Anything without a single explicit host:port (embedded files, multi-host failover) is
 * rejected with a message the user can act on.
 */
export const JDBC_HOSTPORT = /((?:@|\/\/)(?:tcp:\/\/)?)(\[[0-9a-fA-F:]+\]|[A-Za-z0-9._~%-]+):(\d{1,5})(?=[/:;,@\s]|$)/

export function targetFromJdbc(url: string): TunnelTarget {
  const m = JDBC_HOSTPORT.exec(url)
  if (!m) throw new Error('Cannot find a single host:port in the JDBC URL to tunnel to.')
  return { host: m[2].replace(/^\[|\]$/g, ''), port: Number(m[3]) }
}

/** Copy of the config whose address points at the tunnel instead of the real server. */
export function rewriteForTunnel(cfg: ConnectionConfig, localPort: number): ConnectionConfig {
  tunnelTarget(cfg) // same validation, so a bad config can never be half-rewritten
  const uri = cfg.uri?.trim()
  if (cfg.kind !== 'jdbc' && uri) {
    const url = new URL(uri)
    url.hostname = '127.0.0.1'
    url.port = String(localPort)
    return { ...cfg, uri: url.toString() }
  }
  if (cfg.kind === 'jdbc') {
    const url = cfg.jdbc?.url ?? ''
    const m = JDBC_HOSTPORT.exec(url)!
    return { ...cfg, jdbc: { ...cfg.jdbc!, url: url.slice(0, m.index) + m[1] + `127.0.0.1:${localPort}` + url.slice(m.index + m[0].length) } }
  }
  return { ...cfg, host: '127.0.0.1', port: localPort }
}

/* ------------------------------------------------------------------ lifecycle */

export async function acquireTunnel(cfg: ConnectionConfig): Promise<TunnelHandle> {
  const ssh = cfg.ssh
  if (!ssh?.enabled) return { config: cfg, release: () => undefined }
  const target = tunnelTarget(cfg)
  const tunnel = await getTunnel(cfg.id, ssh, target)
  tunnel.refs++
  let released = false
  return {
    config: rewriteForTunnel(cfg, tunnel.localPort),
    release: () => {
      if (released) return
      released = true
      tunnel.refs--
      if (tunnel.refs <= 0) {
        tunnels.delete(cfg.id)
        destroy(tunnel)
      }
    },
  }
}

function getTunnel(key: string, ssh: SshConfig, target: TunnelTarget): Promise<Tunnel> {
  const existing = tunnels.get(key)
  if (existing) return existing
  const holder: { promise?: Promise<Tunnel> } = {}
  // Store the promise before awaiting so two concurrent opens share one handshake. The entry is
  // also dropped as soon as the SSH connection dies, so the next connect starts a fresh tunnel.
  const drop = () => { if (holder.promise && tunnels.get(key) === holder.promise) tunnels.delete(key) }
  const created = createTunnel(ssh, target, drop).catch((e) => { drop(); throw e })
  holder.promise = created
  tunnels.set(key, created)
  return created
}

async function createTunnel(ssh: SshConfig, target: TunnelTarget, onClose: () => void): Promise<Tunnel> {
  const client = new Client()
  const conf = await sshConnectConfig(ssh)
  await new Promise<void>((resolve, reject) => {
    const onReady = () => { cleanup(); resolve() }
    const onError = (e: Error) => { cleanup(); reject(new Error(`SSH tunnel to ${conf.host}:${conf.port} failed: ${e.message}`)) }
    const cleanup = () => { client.removeListener('ready', onReady); client.removeListener('error', onError) }
    client.once('ready', onReady)
    client.once('error', onError)
    client.connect(conf)
  })
  const server = net.createServer((socket) => forward(client, socket, target))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const localPort = (server.address() as net.AddressInfo).port
  const tunnel: Tunnel = { client, server, localPort, refs: 0 }
  // A dropped SSH connection invalidates every forward: stop accepting and surface the state.
  client.on('error', (e) => console.warn(`ssh tunnel ${target.host}:${target.port}:`, e.message))
  client.on('close', () => { server.close(); onClose() })
  server.on('error', (e) => console.warn(`ssh tunnel listener ${localPort}:`, e.message))
  return tunnel
}

/** One database socket, one SSH channel: bytes flow both ways until either side closes. */
function forward(client: Client, socket: net.Socket, target: TunnelTarget) {
  client.forwardOut('127.0.0.1', 0, target.host, target.port, (err, channel) => {
    if (err) { socket.destroy(err); return }
    socket.on('error', () => channel.destroy())
    channel.on('error', () => socket.destroy())
    channel.on('close', () => socket.destroy())
    socket.pipe(channel).pipe(socket)
  })
}

function destroy(t: Tunnel) {
  t.server.close()
  t.client.end()
}

/** Test/quit hook: closes every tunnel regardless of outstanding references. */
export async function closeAllTunnels(): Promise<void> {
  const open = [...tunnels.values()]
  tunnels.clear()
  const settled = await Promise.allSettled(open)
  for (const s of settled) if (s.status === 'fulfilled') destroy(s.value)
}
