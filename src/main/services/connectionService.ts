import type { ConnectionConfig, ConnectionView } from '../../shared/types'
import type { ConnectionExportResult, ConnectionImportResult } from '../../shared/ipc'
import { exportConnections, parseConnections, prepareImport } from '../../core/connectionTransfer'
import type { ConnectionManager } from './connectionManager'
import type { DesktopService } from './desktopService'
import { connectionView, type ConnectionStore } from './store'

/**
 * Application service for data-source metadata and lifecycle. IPC delegates here instead of
 * coordinating the connection store and the live session map itself.
 */
export class ConnectionService {
  constructor(private store: ConnectionStore, private sessions: ConnectionManager, private desktop: DesktopService) {}

  list(): Promise<ConnectionView[]> { return this.store.list() }

  /** Portable JSON in a file the user picks: every data source, no passwords or passphrases. */
  async exportFile(): Promise<ConnectionExportResult | null> {
    const existing = await this.store.list()
    if (!existing.length) throw new Error('There are no data sources to export.')
    const file = await this.desktop.saveFile('stratum-connections.json', exportConnections(existing), [
      { name: 'Connection settings', extensions: ['json'] },
    ])
    return file ? { path: file, count: existing.length } : null
  }

  /** Import validates and strips secrets, then assigns fresh ids so nothing is overwritten. */
  async importFile(): Promise<ConnectionImportResult | null> {
    const file = await this.desktop.openText([{ name: 'Connection settings', extensions: ['json'] }])
    if (!file) return null
    const { connections, warnings } = parseConnections(file.content)
    const existing = await this.store.list()
    const prepared = prepareImport(connections, existing.map((c) => c.name))
    await this.store.saveMany(prepared)
    return { path: file.path, imported: prepared.map(connectionView), warnings }
  }

  async save(config: ConnectionConfig): Promise<void> {
    await this.sessions.close(config.id)
    await this.store.save(config)
  }

  async remove(id: string): Promise<void> {
    await this.sessions.close(id)
    await this.store.remove(id)
  }

  /** Testing an existing source may omit its secrets; merge the stored values in main. */
  async test(config: ConnectionConfig) {
    const stored = await this.store.get(config.id)
    if (!stored) return this.sessions.test(config)
    const storedJumps = new Map((stored.ssh?.jumpHosts ?? []).map((j) => [j.id, j]))
    const ssh = config.ssh
      ? {
          ...stored.ssh,
          ...config.ssh,
          password: config.ssh.password === undefined ? stored.ssh?.password : config.ssh.password,
          passphrase: config.ssh.passphrase === undefined ? stored.ssh?.passphrase : config.ssh.passphrase,
          jumpHosts: config.ssh.jumpHosts?.map((j) => {
            const prev = storedJumps.get(j.id)
            return {
              ...j,
              password: j.password === undefined ? prev?.password : j.password,
              passphrase: j.passphrase === undefined ? prev?.passphrase : j.passphrase,
            }
          }),
        }
      : stored.ssh
    return this.sessions.test({
      ...stored,
      ...config,
      password: config.password === undefined ? stored.password : config.password,
      sslKeyPassphrase: config.sslKeyPassphrase === undefined ? stored.sslKeyPassphrase : config.sslKeyPassphrase,
      ssh,
    })
  }
  open(id: string) { return this.sessions.open(id) }
  reconnect(id: string) { return this.sessions.reconnect(id) }
  close(id: string) { return this.sessions.close(id) }
}
