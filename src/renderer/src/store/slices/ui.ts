import type { UiSlice, WorkbenchSlice } from '../types'

export const createUiSlice: WorkbenchSlice<UiSlice> = (set) => ({
  showResults: true,
  objectSearchOpen: false,
  libraryOpen: false,
  extensionsOpen: false,
  driverManagerOpen: false,
  set: (patch) => set(patch),
})
