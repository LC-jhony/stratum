import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import type { StratumApi } from '../shared/ipc'
import { listDockerContainers } from './services/docker'
import type { ConnectionManager } from './services/connectionManager'
import type { ConnectionService } from './services/connectionService'
import type { DesktopService } from './services/desktopService'
import type { SettingsService } from './services/settingsService'
import type { ThemeService } from './services/themeService'
import {
  connectionSchema,
  dockerEndpointSchema,
  exportSizeSchema,
  filtersSchema,
  idSchema,
  queryOptionsSchema,
  settingsPatchSchema,
  sqlSchema,
  statementsSchema,
  themePathSchema,
} from './ipc/schemas'

type Handlers = { [G in keyof StratumApi]: StratumApi[G] extends Record<string, (...a: any[]) => any> ? StratumApi[G] : never }
type Handler = (...args: any[]) => unknown

export interface IpcDependencies {
  connections: ConnectionService
  sessions: ConnectionManager
  settings: SettingsService
  themes: ThemeService
  desktop: DesktopService
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

  const api: Pick<Handlers, 'connections' | 'db' | 'themes' | 'settings' | 'dialogs' | 'export' | 'docker'> = {
    connections: {
      list: () => d.connections.list(),
      save: (c) => d.connections.save(c),
      remove: (id) => d.connections.remove(id),
      test: (c) => d.connections.test(c),
      open: (id) => d.connections.open(id),
      close: (id) => d.connections.close(id),
    },
    db: {
      introspect: (id) => d.sessions.require(id).introspect(),
      execute: (id, sql, opts) => d.sessions.require(id).execute(sql, opts),
      cancel: (id) => d.sessions.require(id).cancel(),
      submit: (id, statements) => d.sessions.require(id).submit(statements),
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
    dialogs: { pickFile: (filters) => d.desktop.pickFile(filters) },
    docker: { list: (endpoint) => listDockerContainers(endpoint) },
    export: {
      save: (defaultName, content, filters) => d.desktop.saveFile(defaultName, content, filters, 'utf8'),
      saveBinary: (defaultName, base64, filters) => d.desktop.saveFile(defaultName, base64, filters, 'base64'),
      pdf: (defaultName, svg, size) => d.desktop.savePdf(defaultName, svg, size),
    },
  }

  const route = <T extends Record<string, Handler>>(group: string, handlers: T, schemas: Record<string, z.ZodType[]>) => {
    for (const [name, fn] of Object.entries(handlers)) h(`${group}:${name}`, fn, ...(schemas[name] ?? []))
  }

  route('connections', api.connections as unknown as Record<string, Handler>, {
    list: [], save: [connectionSchema], remove: [idSchema], test: [connectionSchema], open: [idSchema], close: [idSchema],
  })
  route('db', api.db as unknown as Record<string, Handler>, {
    introspect: [idSchema], execute: [idSchema, sqlSchema, queryOptionsSchema], cancel: [idSchema], submit: [idSchema, statementsSchema],
  })
  route('themes', api.themes as unknown as Record<string, Handler>, {
    list: [], read: [themePathSchema], importVsCodeExtensions: [],
  })
  route('settings', api.settings as unknown as Record<string, Handler>, {
    get: [], set: [settingsPatchSchema],
  })
  route('dialogs', api.dialogs as unknown as Record<string, Handler>, {
    pickFile: [filtersSchema],
  })
  route('docker', api.docker as unknown as Record<string, Handler>, {
    list: [dockerEndpointSchema],
  })
  route('export', api.export as unknown as Record<string, Handler>, {
    save: [z.string().max(1000), z.string().max(50_000_000), filtersSchema],
    saveBinary: [z.string().max(1000), z.string().max(100_000_000), filtersSchema],
    pdf: [z.string().max(1000), z.string().max(50_000_000), exportSizeSchema],
  })
}
