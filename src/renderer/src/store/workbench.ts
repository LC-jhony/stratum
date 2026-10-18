import { create } from 'zustand'
import { createConnectionsSlice } from './slices/connections'
import { createConsoleSlice } from './slices/console'
import { createPrefsSlice } from './slices/prefs'
import { createTabsSlice } from './slices/tabs'
import { createUiSlice } from './slices/ui'
import type { WorkbenchState } from './types'

/**
 * One Zustand store composed from feature slices. Features keep their state and actions together
 * without turning this facade into a god module.
 */
export const useWorkbench = create<WorkbenchState>((set, get, api) => ({
  ...createConnectionsSlice(set, get, api),
  ...createTabsSlice(set, get, api),
  ...createConsoleSlice(set, get, api),
  ...createPrefsSlice(set, get, api),
  ...createUiSlice(set, get, api),
}))

export type {
  ConsoleTab,
  DiagramTab,
  Live,
  ParamRequest,
  ResultEntry,
  Tab,
  TableTab,
  WorkbenchState,
} from './types'
