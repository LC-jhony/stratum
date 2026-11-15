import { BrowserWindow, ipcMain, Menu } from 'electron'
import { z } from 'zod'
import type { StratumApi } from '../shared/ipc'
import { listDockerContainers } from './services/docker'
import type { ConnectionManager } from './services/connectionManager'
import type { ConnectionService } from './services/connectionService'
import type { DesktopService } from './services/desktopService'
import type { ExtensionService } from './services/extensionService'
import type { HistoryService } from './services/historyService'
import type { QueryLibraryService } from './services/queryLibraryService'
import type { SettingsService } from './services/settingsService'
import type { ThemeService } from './services/themeService'
import type { UpdateService } from './services/updateService'
import {
  connectionSchema,
  dockerEndpointSchema,
  exportSizeSchema,
  filtersSchema,
  idSchema,
  menuPositionSchema,
  queryOptionsSchema,
  savedQuerySchema,
  sessionIdSchema,
  settingsPatchSchema,
  sqlSchema,
  statementsSchema,
  themePathSchema,
} from './ipc/schemas'

type Handlers = { [G in keyof StratumApi]: StratumApi[G] extends Record<string, (...a: any[]) => any> ? StratumApi[G] : never }
/** Main-process side of the API: renderer-bound callbacks such as onState live in preload only. */
type IpcHandlers = Omit<Handlers, 'update' | 'window' | 'connections'> & {
  connections: Omit<StratumApi['connections'], 'onState'>
  update: Omit<StratumApi['update'], 'onState'>
  window: Omit<StratumApi['window'], 'onMaximized'>
}
type Handler = (...args: any[]) => unknown

export interface IpcDependencies {
  connections: ConnectionService
  sessions: ConnectionManager
  settings: SettingsService
  history: HistoryService
  library: QueryLibraryService
  extensions: ExtensionService
  themes: ThemeService
  desktop: DesktopService
  update: UpdateService
  window: () => BrowserWindow | null
}

/**
 * Thin IPC router: validate/trust the caller, delegate to an application service, return its
 * result. No stores, drivers or business rules live here.
 */
export function registerIpc(d: IpcDependencies) {
  const h = (ch: string, fn: Handler, ...schemas: z.ZodType[]) => {
    ipcMain.handle(ch, (event, ...args) => {
      const win = d.window()
      // Only the main window's renderer may call the bridge. A hidden export window has no preload,
      // but this check also rejects calls from any future window or compromised subframe.
      if (!win || win.isDestroyed() || event.sender !== win.webContents) throw new Error('Rejected IPC call from an untrusted sender')
      if (args.length !== schemas.length) throw new Error(`Invalid argument count for ${ch}`)
      const parsed = schemas.map((schema, i) => schema.parse(args[i]))
      return fn(...parsed)
    })
  }

  const api: Pick<IpcHandlers, 'connections' | 'db' | 'themes' | 'settings' | 'history' | 'library' | 'extensions' | 'dialogs' | 'export' | 'docker' | 'update' | 'window'> = {
    connections: {
      list: () => d.connections.list(),
      save: (c) => d.connections.save(c),
      remove: (id) => d.connections.remove(id),
      test: (c) => d.connections.test(c),
      open: (id) => d.connections.open(id),
      close: (id) => d.connections.close(id),
      reconnect: (id) => d.connections.reconnect(id),
    },
    db: {
      introspect: (id) => d.sessions.require(id).introspect(),
      execute: (id, sql, opts) => d.sessions.require(id).execute(sql, opts),
      cancel: (id) => d.sessions.require(id).cancel(),
      submit: (id, statements) => d.sessions.require(id).submit(statements),
      plan: (id, sql) => d.sessions.require(id).plan(sql),
      transaction: async (id) => d.sessions.require(id).transaction(),
      begin: (id) => d.sessions.require(id).begin(),
      commit: (id) => d.sessions.require(id).commit(),
      rollback: (id) => d.sessions.require(id).rollback(),
      sessions: (id) => d.sessions.require(id).sessions(),
      killSession: (id, pid) => d.sessions.require(id).killSession(pid),
    },
    themes: {
      list: () => d.themes.list(),
      read: (path) => d.themes.read(path),
      importVsCodeExtensions: () => d.themes.importVsCodeExtensions(),
    },
    settings: {
      get: () => d.settings.get(),
      set: (patch) => d.settings.update(patch).then(() => undefined),
    },
    history: {
      get: () => d.history.get(),
      add: (connectionId, statements) => d.history.add(connectionId, statements),
    },
    library: {
      list: () => d.library.list(),
      save: (query) => d.library.save(query),
      remove: (id) => d.library.remove(id),
    },
    extensions: {
      list: () => d.extensions.list(),
      setEnabled: (id, enabled) => d.extensions.setEnabled(id, enabled),
    },
    dialogs: {
      pickFile: (filters) => d.desktop.pickFile(filters),
      openText: (filters) => d.desktop.openText(filters),
    },
    docker: { list: (endpoint) => listDockerContainers(endpoint) },
    export: {
      save: (defaultName, content, filters) => d.desktop.saveFile(defaultName, content, filters, 'utf8'),
      saveBinary: (defaultName, base64, filters) => d.desktop.saveFile(defaultName, base64, filters, 'base64'),
      pdf: (defaultName, svg, size) => d.desktop.savePdf(defaultName, svg, size),
    },
    update: {
      state: async () => d.update.getState(),
      check: () => d.update.check('manual'),
      download: () => d.update.download('manual'),
      install: async () => { d.update.install() },
      openReleasePage: async () => { d.update.openReleasePage() },
    },
    window: {
      minimize: async () => { d.window()?.minimize() },
      toggleMaximize: async () => {
        const win = d.window()
        if (!win) return
        if (win.isMaximized()) win.unmaximize()
        else win.maximize()
      },
      close: async () => { d.window()?.close() },
      isMaximized: async () => d.window()?.isMaximized() ?? false,
      showMenu: async ({ x, y }) => {
        const win = d.window()
        if (win) Menu.getApplicationMenu()?.popup({ window: win, x, y })
      },
    },
  }

  const route = <T extends Record<string, Handler>>(group: string, handlers: T, schemas: Record<string, z.ZodType[]>) => {
    for (const [name, fn] of Object.entries(handlers)) h(`${group}:${name}`, fn, ...(schemas[name] ?? []))
  }

  route('connections', api.connections as unknown as Record<string, Handler>, {
    list: [], save: [connectionSchema], remove: [idSchema], test: [connectionSchema], open: [idSchema], close: [idSchema],
    reconnect: [idSchema],
  })
  route('db', api.db as unknown as Record<string, Handler>, {
    introspect: [idSchema], execute: [idSchema, sqlSchema, queryOptionsSchema], cancel: [idSchema], submit: [idSchema, statementsSchema],
    plan: [idSchema, sqlSchema], transaction: [idSchema], begin: [idSchema], commit: [idSchema], rollback: [idSchema],
    sessions: [idSchema], killSession: [idSchema, sessionIdSchema],
  })
  route('themes', api.themes as unknown as Record<string, Handler>, {
    list: [], read: [themePathSchema], importVsCodeExtensions: [],
  })
  route('settings', api.settings as unknown as Record<string, Handler>, {
    get: [], set: [settingsPatchSchema],
  })
  route('history', api.history as unknown as Record<string, Handler>, {
    get: [], add: [idSchema, statementsSchema],
  })
  route('library', api.library as unknown as Record<string, Handler>, {
    list: [], save: [savedQuerySchema], remove: [idSchema],
  })
  route('extensions', api.extensions as unknown as Record<string, Handler>, {
    list: [], setEnabled: [idSchema, z.boolean()],
  })
  route('dialogs', api.dialogs as unknown as Record<string, Handler>, {
    pickFile: [filtersSchema],
    openText: [filtersSchema],
  })
  route('docker', api.docker as unknown as Record<string, Handler>, {
    list: [dockerEndpointSchema],
  })
  route('export', api.export as unknown as Record<string, Handler>, {
    // "All rows" caps at 1,000,000 rows; these ceilings leave room for a very wide CSV and the
    // base64 expansion of a large workbook without truncating silently.
    save: [z.string().max(1000), z.string().max(300_000_000), filtersSchema],
    saveBinary: [z.string().max(1000), z.string().max(400_000_000), filtersSchema],
    pdf: [z.string().max(1000), z.string().max(50_000_000), exportSizeSchema],
  })
  route('update', api.update as unknown as Record<string, Handler>, {
    state: [], check: [], download: [], install: [], openReleasePage: [],
  })
  route('window', api.window as unknown as Record<string, Handler>, {
    minimize: [], toggleMaximize: [], close: [], isMaximized: [], showMenu: [menuPositionSchema],
  })
}
