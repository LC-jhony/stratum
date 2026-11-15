import type { SavedQuery } from '../../shared/types'
import type { JsonStore } from './store'

/**
 * Saved-query library ("SQL scripts" in DataGrip terms). One JSON file, newest edit first.
 * Names are trimmed and empty names are refused instead of silently creating a blank entry.
 */
export class QueryLibraryService {
  constructor(private store: JsonStore<{ queries: SavedQuery[] }>) {}

  async list(): Promise<SavedQuery[]> {
    return [...(await this.store.read()).queries].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async save(query: SavedQuery): Promise<void> {
    const name = query.name.trim()
    if (!name) throw new Error('The saved query needs a name.')
    if (!query.sql.trim()) throw new Error('The saved query is empty.')
    const state = await this.store.read()
    const now = Date.now()
    const index = state.queries.findIndex((q) => q.id === query.id)
    const entry: SavedQuery = {
      ...query,
      name,
      createdAt: index >= 0 ? state.queries[index].createdAt : query.createdAt || now,
      updatedAt: now,
    }
    if (index >= 0) state.queries[index] = entry
    else state.queries.push(entry)
    await this.store.write(state)
  }

  async remove(id: string): Promise<void> {
    const state = await this.store.read()
    state.queries = state.queries.filter((q) => q.id !== id)
    await this.store.write(state)
  }
}
