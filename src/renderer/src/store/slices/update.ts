import { ipc } from '../../ipc/client'
import type { UpdateSlice, WorkbenchSlice } from '../types'

/** Mirrors the main-process update state; every mutation here comes from an IPC snapshot. */
export const createUpdateSlice: WorkbenchSlice<UpdateSlice> = (set, get) => ({
  update: undefined,
  updatesOpen: false,

  async initUpdates() {
    let off = () => {}
    try {
      off = ipc.update.onState((update) => set({ update }))
      const initial = await ipc.update.state()
      // A transition may have arrived while state() was in flight; never overwrite it with an older read.
      set((s) => ({ update: s.update ?? initial }))
    } catch (e) {
      console.error('initialising updates:', e)
    }
    return off
  },

  showUpdates: () => set({ updatesOpen: true }),
  hideUpdates: () => set({ updatesOpen: false }),

  async checkUpdates(open = true) {
    if (open) set({ updatesOpen: true })
    try { set({ update: await ipc.update.check() }) }
    catch (e) {
      const current = get().update
      if (current) set({ update: { ...current, phase: 'error', origin: 'manual', error: String(e) } })
    }
  },

  async downloadUpdate() {
    try { set({ update: await ipc.update.download() }) }
    catch (e) {
      const current = get().update
      if (current) set({ update: { ...current, phase: 'error', origin: 'manual', error: String(e) } })
    }
  },

  async installUpdate() {
    try { await ipc.update.install() }
    catch (e) { console.error('install update:', e) }
  },
})
