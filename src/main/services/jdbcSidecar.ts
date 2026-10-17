import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_PORT = 7823

/** Runtime configuration, read on every use so the Settings dialog can change it without recreating the sidecar. */
export interface JdbcRuntime {
  jar?: string
  port?: number
  javaHome?: string
}

/** Owns the single jdbc-adapter-server process shared by all JDBC data sources. */
export class JdbcSidecar {
  private proc?: ChildProcess
  private starting?: Promise<void>
  constructor(private runtime: () => JdbcRuntime = () => ({})) { }
  private get port() { return this.runtime().port ?? DEFAULT_PORT }

  async post<T>(endpoint: string, body: unknown): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${this.port}/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`JDBC adapter ${endpoint} failed: HTTP ${res.status}`)
    return (await res.json()) as T
  }
  private async alive() {
    try { return (await fetch(`http://127.0.0.1:${this.port}/test`, { signal: AbortSignal.timeout(500) })).ok } catch { return false }
  }
  ensureRunning(): Promise<void> {
    return (this.starting ??= this.start().catch((e) => { this.starting = undefined; throw e }))
  }
  private async start() {
    if (await this.alive()) return
    const { jar, javaHome } = this.runtime()
    if (!jar || !existsSync(jar)) throw new Error('jdbc-adapter-server.jar not found. Run "npm run fetch:jdbc", set STRATUM_JDBC_JAR or configure the path in Settings.')
    const java = javaHome ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'
    this.proc = spawn(java, ['-jar', jar], { stdio: 'ignore', windowsHide: true })
    const failed = new Promise<never>((_, rej) => this.proc!.once('error', () => rej(new Error('Java runtime (JRE 11+) was not found. Install one or set JAVA_HOME.'))))
    const ready = (async () => { for (let i = 0; i < 60; i++) { if (await this.alive()) return; await new Promise((r) => setTimeout(r, 250)) } throw new Error('jdbc-adapter-server did not start within 15s') })()
    await Promise.race([ready, failed])
    this.proc.once('exit', () => { this.proc = undefined; this.starting = undefined })
  }
  stop() { this.proc?.kill(); this.proc = undefined; this.starting = undefined }
}
