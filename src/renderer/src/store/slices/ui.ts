import type { UiSlice, WorkbenchSlice } from '../types'

export const createUiSlice: WorkbenchSlice<UiSlice> = (set) => ({
  showResults: true,
  objectSearchOpen: false,
  libraryOpen: false,
  extensionsOpen: false,
  set: (patch) => set(patch),
})
