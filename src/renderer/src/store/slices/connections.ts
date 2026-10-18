import { ipc } from '../../ipc/client'
import { mergeSettings } from '../../../../shared/settings'
import type { ConnectionConfig } from '../../../../shared/types'
import type { ConnectionsSlice, WorkbenchSlice } from '../types'

const cleanIpcError = (e: unknown) => e instanceof Error
  ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  : String(e)

export const createConnectionsSlice: WorkbenchSlice<ConnectionsSlice> = (set, get) => ({
  connections: [],
  live: {},

  async load() {
    const [connections, raw] = await Promise.all([ipc.connections.list(), ipc.settings.get()])
    set({ connections, prefs: mergeSettings(raw), prefsLoaded: true })
  },

  async saveConnection(c: ConnectionConfig) {
    await ipc.connections.save(c)
    set((s) => ({ live: Object.fromEntries(Object.entries(s.live).filter(([k]) => k !== c.id)) }))
    await get().load()
  },

  async removeConnection(id) {
    await ipc.connections.remove(id)
    set((s) => ({ tabs: s.tabs.filter((t) => t.connectionId !== id) }))
    await get().load()
  },

  async connect(id) {
    if (get().live[id]?.status === 'ready' || get().live[id]?.status === 'connecting') return
    set((s) => ({ live: { ...s.live, [id]: { status: 'connecting' } } }))
    try {
      const { version } = await ipc.connections.open(id)
      set((s) => ({ live: { ...s.live, [id]: { status: 'ready', version, loadingModel: true } } }))
      await get().refresh(id)
    } catch (e) {
      set((s) => ({ live: { ...s.live, [id]: { status: 'error', error: cleanIpcError(e) } } }))
    }
  },

  async disconnect(id) {
    await ipc.connections.close(id)
    set((s) => {
      const live = { ...s.live }
      delete live[id]
      return { live }
    })
  },

  async refresh(id) {
    set((s) => ({ live: { ...s.live, [id]: { ...s.live[id], status: 'ready', loadingModel: true } } }))
    try {
      const model = await ipc.db.introspect(id)
      set((s) => ({ live: { ...s.live, [id]: { ...s.live[id], model, loadingModel: false } } }))
    } catch (e) {
      set((s) => ({ live: { ...s.live, [id]: { ...s.live[id], loadingModel: false, error: String(e) } } }))
    }
  },
})
