import type { UiSlice, WorkbenchSlice } from '../types'

export const createUiSlice: WorkbenchSlice<UiSlice> = (set) => ({
  showResults: true,
  set: (patch) => set(patch),
})
