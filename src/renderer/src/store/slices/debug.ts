import type { DebugSnapshot } from '../../../../shared/types'
import { ipc } from '../../ipc/client'
import { uid } from '../internal'
import type { DebugSlice, DebugTab, WorkbenchSlice } from '../types'

const clean = (e: unknown) => (e instanceof Error ? e.message : String(e))
  .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')

/**
 * Debug tabs own one main-process session each. Every command returns a full snapshot, so the
 * renderer never reconstructs stack or variable state locally; it only decides when a late
 * response must be ignored (after Stop).
 */
export const createDebugSlice: WorkbenchSlice<DebugSlice> = (set, get) => {
  const tabOf = (tabId: string): DebugTab | undefined => {
    const tab = get().tabs.find((t) => t.id === tabId)
    return tab?.type === 'debug' ? tab : undefined
  }

  const apply = (tabId: string, snapshot: DebugSnapshot) => {
    const tab = tabOf(tabId)
    if (!tab) return
    // A stop was requested: a step response that arrives late must not resurrect the paused view.
    if (tab.stopping && snapshot.status !== 'stopped') return
    set((s) => ({
      tabs: s.tabs.map((t) => t.id === tabId && t.type === 'debug'
        ? {
            ...t,
            snapshot,
            status: snapshot.status,
            error: snapshot.error,
            busy: false,
            stopping: snapshot.status === 'stopped' ? false : t.stopping,
          }
        : t),
    }))
  }

  const fail = (tabId: string, e: unknown) => {
    if (!tabOf(tabId)) return
    set((s) => ({
      tabs: s.tabs.map((t) => t.id === tabId && t.type === 'debug'
        ? { ...t, error: clean(e), busy: false, stopping: false }
        : t),
    }))
  }

  /** Run one command against the tab's session; step commands block until the next stop. */
  const command = async (tabId: string, run: (sessionId: string) => Promise<DebugSnapshot>) => {
    const tab = tabOf(tabId)
    if (!tab || tab.busy || tab.stopping) return
    set((s) => ({ tabs: s.tabs.map((t) => t.id === tabId && t.type === 'debug' ? { ...t, busy: true, error: undefined } : t) }))
    try {
      apply(tabId, await run(tab.sessionId))
    } catch (e) {
      fail(tabId, e)
    }
  }

  return {
    openDebugPicker: (connectionId) => set({ debugPicker: connectionId }),

    openDebug(connectionId, snapshot) {
      const tab: DebugTab = {
        id: uid('debug'),
        type: 'debug',
        connectionId,
        title: `Debug ${snapshot.routine.name}`,
        sessionId: snapshot.id,
        status: snapshot.status,
        routine: snapshot.routine,
        snapshot,
      }
      set((s) => ({ tabs: [...s.tabs, tab], activeTab: tab.id, debugPicker: undefined }))
      return tab.id
    },

    debugResume: (tabId) => command(tabId, (id) => ipc.debug.resume(id)),
    debugStepOver: (tabId) => command(tabId, (id) => ipc.debug.stepOver(id)),
    debugStepInto: (tabId) => command(tabId, (id) => ipc.debug.stepInto(id)),
    debugSelectFrame: (tabId, level) => command(tabId, (id) => ipc.debug.selectFrame(id, level)),

    debugToggleBreakpoint(tabId, line) {
      const tab = tabOf(tabId)
      if (!tab || tab.stopping || tab.status === 'stopped') return
      const oid = tab.snapshot.source?.oid ?? tab.routine.oid
      const enabled = !tab.snapshot.breakpoints.some((b) => b.oid === oid && b.line === line)
      void ipc.debug.setBreakpoint(tab.sessionId, oid, line, enabled)
        .then((snapshot) => apply(tabId, snapshot))
        .catch((e: unknown) => fail(tabId, e))
    },

    debugSetVariable: (tabId, name, line, value) => command(tabId, (id) => ipc.debug.setVariable(id, name, line, value)),

    async debugStop(tabId) {
      const tab = tabOf(tabId)
      // Stop must stay available while a step command is blocked waiting for a breakpoint.
      if (!tab || tab.stopping || tab.status === 'stopped') return
      set((s) => ({ tabs: s.tabs.map((t) => t.id === tabId && t.type === 'debug' ? { ...t, stopping: true, error: undefined } : t) }))
      try {
        apply(tabId, await ipc.debug.stop(tab.sessionId))
      } catch (e) {
        fail(tabId, e)
      }
    },
  }
}
