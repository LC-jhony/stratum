import type { JsonStore } from './store'

type HistoryData = { queries: Record<string, string[]> }

const CAP = 100

/** Per-connection console history. Kept out of settings.json so it cannot grow that file without bound. */
export class HistoryService {
  constructor(private store: JsonStore<HistoryData>) {}

  async get(): Promise<Record<string, string[]>> {
    return structuredClone((await this.store.read()).queries)
  }

  async add(connectionId: string, statements: string[]): Promise<void> {
    if (!statements.length) return
    const data = await this.store.read()
    const previous = data.queries[connectionId] ?? []
    data.queries[connectionId] = [...new Set([...statements, ...previous])].slice(0, CAP)
    await this.store.write(data)
  }

  /**
   * Move the legacy `query.history` map from settings.json into history.json. Merge instead of
   * replacing so an interrupted migration can safely run again on the next start.
   */
  async importLegacy(legacy: unknown): Promise<boolean> {
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return false
    const data = await this.store.read()
    let imported = false
    for (const [id, values] of Object.entries(legacy as Record<string, unknown>)) {
      if (!Array.isArray(values)) continue
      const clean = values.filter((v): v is string => typeof v === 'string')
      if (!clean.length) continue
      data.queries[id] = [...new Set([...clean, ...(data.queries[id] ?? [])])].slice(0, CAP)
      imported = true
    }
    if (imported) await this.store.write(data)
    return imported
  }
}
