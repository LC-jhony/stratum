import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import type { StratumApi } from '../shared/ipc'
import type { ConnectionManager } from './services/connectionManager'
import type { ConnectionStore, JsonStore } from './services/store'
import type { ThemeService } from './services/themeService'

type Handlers = { [G in keyof StratumApi]: StratumApi[G] extends Record<string, (...a: any[]) => any> ? StratumApi[G] : never }

/** Wires every renderer call to a service. Channel names are derived from the API shape, so the two cannot drift. */
export function registerIpc(d: { connections: ConnectionStore; manager: ConnectionManager; themes: ThemeService; settings: JsonStore<Record<string, unknown>>; window: () => BrowserWindow | null; onSettingsChanged?: (patch: Record<string, unknown>) => void }) {
  const h = (ch: string, fn: (...a: any[]) => unknown) => ipcMain.handle(ch, (_e, ...a) => fn(...a))
  const api: Pick<Handlers, 'connections' | 'db' | 'themes' | 'settings' | 'dialogs' | 'export'> = {
    connections: {
      list: () => d.connections.list(),
      save: async (c) => { await d.manager.reset(c.id); await d.connections.save(c) },
      remove: async (id) => { await d.manager.close(id); await d.connections.remove(id) },
      test: (c) => d.manager.test(c),
      open: (id) => d.manager.open(id),
      close: (id) => d.manager.close(id),
    },
    db: {
      introspect: (id) => d.manager.require(id).introspect(),
      execute: (id, sql, opts) => d.manager.require(id).execute(sql, opts),
      cancel: (id) => d.manager.require(id).cancel(),
      submit: (id, s) => d.manager.require(id).submit(s),
    },
    themes: { list: () => d.themes.list(), read: (p) => d.themes.read(p), importVsCodeExtensions: () => d.themes.importVsCodeExtensions() },
    settings: { get: () => d.settings.read(), set: async (patch) => { await d.settings.write({ ...(await d.settings.read()), ...patch }); d.onSettingsChanged?.(patch) } },
    dialogs: { pickFile: async (filters) => (await dialog.showOpenDialog(d.window()!, { properties: ['openFile'], filters })).filePaths[0] },
    export: {
      save: async (defaultName, content) => {
        const win = d.window()
        if (!win) return null
        const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: defaultName })
        if (canceled || !filePath) return null
        await writeFile(filePath, content, 'utf8')
        return filePath
      },
    },
  }
  for (const [group, fns] of Object.entries(api)) for (const [name, fn] of Object.entries(fns)) h(`${group}:${name}`, fn as never)
}
