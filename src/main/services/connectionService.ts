import type { ConnectionConfig, ConnectionView } from '../../shared/types'
import type { ConnectionManager } from './connectionManager'
import type { ConnectionStore } from './store'

/**
 * Application service for data-source metadata and lifecycle. IPC delegates here instead of
 * coordinating the connection store and the live session map itself.
 */
export class ConnectionService {
  constructor(private store: ConnectionStore, private sessions: ConnectionManager) {}

  list(): Promise<ConnectionView[]> { return this.store.list() }

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
    const ssh = config.ssh
      ? {
          ...stored.ssh,
          ...config.ssh,
          password: config.ssh.password === undefined ? stored.ssh?.password : config.ssh.password,
          passphrase: config.ssh.passphrase === undefined ? stored.ssh?.passphrase : config.ssh.passphrase,
        }
      : stored.ssh
    return this.sessions.test({
      ...stored,
      ...config,
      password: config.password === undefined ? stored.password : config.password,
      ssh,
    })
  }
  open(id: string) { return this.sessions.open(id) }
  close(id: string) { return this.sessions.close(id) }
}
