import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { StratumApi } from '../shared/ipc'
import type { ConnectionManager } from './services/connectionManager'
import { listDockerContainers } from './services/docker'
import type { ConnectionStore, JsonStore } from './services/store'
import type { ThemeService } from './services/themeService'

type Handlers = { [G in keyof StratumApi]: StratumApi[G] extends Record<string, (...a: any[]) => any> ? StratumApi[G] : never }

/** Wires every renderer call to a service. Channel names are derived from the API shape, so the two cannot drift. */
export function registerIpc(d: { connections: ConnectionStore; manager: ConnectionManager; themes: ThemeService; settings: JsonStore<Record<string, unknown>>; window: () => BrowserWindow | null; onSettingsChanged?: (patch: Record<string, unknown>) => void }) {
  const h = (ch: string, fn: (...a: any[]) => unknown) => ipcMain.handle(ch, (_e, ...a) => fn(...a))
  const api: Pick<Handlers, 'connections' | 'db' | 'themes' | 'settings' | 'dialogs' | 'export' | 'docker'> = {
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
    dialogs: { pickFile: async (filters) => { const win = d.window(); if (!win) return undefined; return (await dialog.showOpenDialog(win, { properties: ['openFile'], filters })).filePaths[0] } },
    docker: { list: (endpoint) => listDockerContainers(endpoint) },
    export: {
      save: async (defaultName, content, filters) => {
        const win = d.window()
        if (!win) return null
        const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters })
        if (canceled || !filePath) return null
        await writeFile(filePath, content, 'utf8')
        return filePath
      },
      saveBinary: async (defaultName, base64, filters) => {
        const win = d.window()
        if (!win) return null
        const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters })
        if (canceled || !filePath) return null
        await writeFile(filePath, base64, 'base64')
        return filePath
      },
      /** Vector PDF sized to the diagram: a hidden window renders the standalone SVG and Chromium prints the page. */
      pdf: async (defaultName, svg, size) => {
        const win = d.window()
        if (!win) return null
        const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
        if (canceled || !filePath) return null
        const w = Math.max(1, Math.round(size.width)), h = Math.max(1, Math.round(size.height))
        const tmp = path.join(app.getPath('temp'), `stratum-print-${process.pid}-${Date.now()}.html`)
        const page = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
        try {
          await writeFile(tmp, `<!doctype html><meta charset="utf-8"><style>@page{size:${w}px ${h}px;margin:0}html,body{margin:0;padding:0}svg{display:block}</style>${svg}`, 'utf8')
          await page.loadFile(tmp)
          const data = await page.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true, margins: { top: 0, right: 0, bottom: 0, left: 0 } })
          await writeFile(filePath, data)
          return filePath
        } finally {
          if (!page.isDestroyed()) page.destroy()
          await rm(tmp, { force: true })
        }
      },
    },
  }
  for (const [group, fns] of Object.entries(api)) for (const [name, fn] of Object.entries(fns)) h(`${group}:${name}`, fn as never)
}
