import { mergeSettings, type StratumSettings } from '../../core/settings'
import { seal, unseal, type JsonStore } from './store'

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
  async get(): Promise<StratumSettings> {
    const raw = await this.store.read()
    // New installs start in dark mode. A settings file that already chose a mode wins; a pinned
    // theme with no mode yet keeps its own flavour instead of flipping to the other one.
    if (raw['appearance.mode'] === undefined) {
      const pinned = typeof raw.colorTheme === 'string' ? raw.colorTheme.toLowerCase() : ''
      raw['appearance.mode'] = /light/.test(pinned) ? 'light' : 'dark'
      await this.store.write(raw)
    }
    return mergeSettings(raw)
  }

  /**
   * Settings safe for the renderer: the sealed API key is replaced by a boolean. A blank
   * `ai.apiKey` from the settings draft means "keep the stored key"; `null` clears it.
   */
  async getPublic(): Promise<Record<string, unknown>> {
    const all = await this.get()
    const key = typeof all['ai.apiKey'] === 'string' ? all['ai.apiKey'] : ''
    return { ...all, 'ai.apiKey': '', 'ai.hasKey': !!key }
  }

  /** Plain API key for the main-process AI client; never crosses IPC. */
  async aiKey(): Promise<string | undefined> {
    const key = (await this.get())['ai.apiKey']
    return typeof key === 'string' && key ? unseal(key) : undefined
  }

  async update(patch: Patch): Promise<StratumSettings> {
    const clean = { ...patch }
    delete clean['ai.hasKey']
    const key = clean['ai.apiKey']
    if (typeof key === 'string') {
      if (key.trim()) clean['ai.apiKey'] = seal(key.trim())
      else delete clean['ai.apiKey']
    } else if (key === null) clean['ai.apiKey'] = ''
    const next = mergeSettings({ ...(await this.store.read()), ...clean })
    await this.store.write(next as unknown as Record<string, unknown>)
    for (const listener of this.listeners) listener(clean, next)
    return next
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
