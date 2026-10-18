import { ipc } from '../../ipc/client'
import { DEFAULT_SETTINGS, mergeSettings } from '../../../../core/settings'
import type { PrefsSlice, WorkbenchSlice } from '../types'

export const createPrefsSlice: WorkbenchSlice<PrefsSlice> = (set, get) => ({
  prefs: DEFAULT_SETTINGS,
  prefsLoaded: false,
  settingsOpen: false,

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  async savePrefs(patch) {
    const prefs = mergeSettings({ ...get().prefs, ...patch } as Record<string, unknown>)
    set({ prefs })
    await ipc.settings.set(patch as Record<string, unknown>)
  },

  previewPrefs: (patch) => set((s) => ({ prefs: mergeSettings({ ...s.prefs, ...patch } as Record<string, unknown>) })),
})
