import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * The bundled adapter JAR hardcodes this loopback port and accepts no port argument. Callers may
 * override it for tests; production always uses 7823.
 */
export const JDBC_PORT = 7823

/** Runtime configuration, read on every use so the Settings dialog can change it without recreating the sidecar. */
export interface JdbcRuntime {
  jar?: string
  javaHome?: string
}

export interface JdbcTimeouts {
  /** Waiting for the JVM to bind the port. */
  start: number
  /** `POST /connect` can be slow against a remote server through a VPN. */
  connect: number
  /** `/test`, `/alive`, `/cancel`, `/close`. */
  test: number
  /** A long analytical query must be allowed to finish. */
  execute: number
}

const DEFAULT_TIMEOUTS: JdbcTimeouts = { start: 60_000, connect: 60_000, test: 30_000, execute: 30 * 60_000 }

export interface JdbcSidecarOptions {
  port?: number
  timeouts?: Partial<JdbcTimeouts>
}

const formatDuration = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`)

const isTimeout = (e: unknown): boolean => {
  const name = (e as { name?: string })?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

/** Owns the single jdbc-adapter-server process shared by all JDBC data sources. */
export class JdbcSidecar {
  private proc?: ChildProcess
  private starting?: Promise<void>
  private readonly timeouts: JdbcTimeouts
  constructor(private runtime: () => JdbcRuntime = () => ({}), private opts: JdbcSidecarOptions = {}) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts }
  }

  private get base(): string { return `http://127.0.0.1:${this.opts.port ?? JDBC_PORT}` }

  private timeoutFor(endpoint: string): number {
    if (endpoint === 'connect') return this.timeouts.connect
    if (endpoint === 'execute') return this.timeouts.execute
    return this.timeouts.test
  }

  async post<T>(endpoint: string, body: unknown, timeoutMs?: number): Promise<T> {
    const ms = timeoutMs ?? this.timeoutFor(endpoint)
    let res: Response
    try {
      res = await fetch(`${this.base}/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ms),
      })
    } catch (e) {
      if (isTimeout(e)) throw new Error(`The JDBC adapter did not answer ${endpoint} within ${formatDuration(ms)}. The server may be unreachable or the query may still be running.`)
      throw new Error(`Cannot reach the JDBC adapter on 127.0.0.1:${this.opts.port ?? JDBC_PORT} (${e instanceof Error ? e.message : String(e)}).`)
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300)
      throw new Error(`JDBC adapter ${endpoint} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`)
    }
    try {
      return (await res.json()) as T
    } catch {
      throw new Error(`JDBC adapter ${endpoint} returned a non-JSON response. Is another program using port ${this.opts.port ?? JDBC_PORT}?`)
    }
  }

  /**
   * `true` only when the adapter itself answers: a random HTTP server on the same port would also
   * accept connections, and silently talking to it would fail in confusing ways later.
   */
  private async alive(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/test`, { signal: AbortSignal.timeout(Math.min(this.timeouts.test, 3000)) })
      if (!res.ok) return false
      return (await res.text()).trim() === '"hello"'
    } catch { return false }
  }

  /** Distinguishes "nothing there" from "something else owns the port" before spawning Java. */
  private async portState(): Promise<'ours' | 'free' | 'other'> {
    let res: Response
    try {
      res = await fetch(`${this.base}/test`, { signal: AbortSignal.timeout(1000) })
    } catch (e) {
      const code = (e as { cause?: { code?: string } })?.cause?.code
      // Connection refused is the only state in which we may spawn; a timeout means a hung listener.
      return code === 'ECONNREFUSED' || code === 'ECONNRESET' ? 'free' : 'other'
    }
    if (!res.ok) return 'other'
    return (await res.text().catch(() => '')).trim() === '"hello"' ? 'ours' : 'other'
  }

  ensureRunning(): Promise<void> {
    return (this.starting ??= this.start().catch((e) => { this.starting = undefined; throw e }))
  }

  private async start() {
    const state = await this.portState()
    if (state === 'ours') return
    if (state === 'other') {
      throw new Error(`Port ${this.opts.port ?? JDBC_PORT} is already in use by another program that is not the JDBC adapter. Stop it and reconnect, or free the port.`)
    }
    const { jar, javaHome } = this.runtime()
    if (!jar || !existsSync(jar)) throw new Error('jdbc-adapter-server.jar not found. Run "npm run fetch:jdbc", set STRATUM_JDBC_JAR or configure the path in Settings.')
    const java = javaHome ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'
    const proc = spawn(java, ['-jar', jar], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    this.proc = proc
    // Keep the tail of stderr: a JVM that dies on startup explains why far better than "timed out".
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-8000) })
    const detail = () => (stderr.trim() ? `: ${stderr.trim().split('\n').slice(-6).join(' ')}` : '')

    const failed = new Promise<never>((_, reject) => {
      proc.once('error', (e: NodeJS.ErrnoException) => {
        reject(e.code === 'ENOENT'
          ? new Error(`Java runtime (JRE 11+) was not found at "${java}". Install one or set JAVA_HOME.`)
          : new Error(`Cannot start the JDBC adapter: ${e.message}`))
      })
      proc.once('exit', (code, signal) => {
        reject(new Error(`jdbc-adapter-server stopped during startup (${signal ?? `exit code ${code}`})${detail()}`))
      })
    })

    const ready = (async () => {
      const deadline = Date.now() + this.timeouts.start
      while (Date.now() < deadline) {
        if (await this.alive()) return
        await new Promise((r) => setTimeout(r, 250))
      }
      throw new Error(`jdbc-adapter-server did not start within ${formatDuration(this.timeouts.start)}${detail()}`)
    })()

    try {
      await Promise.race([ready, failed])
    } catch (e) {
      proc.kill()
      if (this.proc === proc) this.proc = undefined
      throw e
    }
    proc.once('exit', () => {
      if (this.proc === proc) this.proc = undefined
      this.starting = undefined
    })
  }

  /** Stops the owned process; the next JDBC connection starts a fresh one. */
  stop() {
    const proc = this.proc
    this.proc = undefined
    this.starting = undefined
    proc?.kill()
  }
}
