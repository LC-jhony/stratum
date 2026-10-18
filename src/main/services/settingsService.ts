import { mergeSettings, type StratumSettings } from '../../core/settings'
import type { JsonStore } from './store'

type Patch = Record<string, unknown>
type Listener = (patch: Patch, settings: StratumSettings) => void

/**
 * Owns the settings.json file. Rendering and persistence are deliberately kept in the main
 * process; renderer callers go through IPC and never touch the file system.
 */
export class SettingsService {
  private listeners = new Set<Listener>()

  constructor(private store: JsonStore<Record<string, unknown>>) {}

  /** Coerce persisted values through the schema on every read, including files edited by hand. */
  async get(): Promise<StratumSettings> { return mergeSettings(await this.store.read()) }

  async update(patch: Patch): Promise<StratumSettings> {
    const next = mergeSettings({ ...(await this.store.read()), ...patch })
    await this.store.write(next as unknown as Record<string, unknown>)
    for (const listener of this.listeners) listener(patch, next)
    return next
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
