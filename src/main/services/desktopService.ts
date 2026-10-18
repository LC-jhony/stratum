import { app, BrowserWindow, dialog } from 'electron'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SaveFilter } from '../../shared/ipc'

/** Native dialogs, file saves and PDF rendering. Keeps Electron UI plumbing out of IPC routers. */
export class DesktopService {
  constructor(private window: () => BrowserWindow | null) {}

  async pickFile(filters?: SaveFilter[]): Promise<string | undefined> {
    const win = this.window()
    if (!win) return undefined
    return (await dialog.showOpenDialog(win, { properties: ['openFile'], filters })).filePaths[0]
  }

  async saveFile(defaultName: string, content: string, filters?: SaveFilter[], encoding: BufferEncoding = 'utf8'): Promise<string | null> {
    const win = this.window()
    if (!win) return null
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters })
    if (canceled || !filePath) return null
    await writeFile(filePath, content, encoding)
    return filePath
  }

  async savePdf(defaultName: string, svg: string, size: { width: number; height: number }): Promise<string | null> {
    const win = this.window()
    if (!win) return null
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (canceled || !filePath) return null
    const width = Math.max(1, Math.round(size.width))
    const height = Math.max(1, Math.round(size.height))
    const tmp = path.join(app.getPath('temp'), `stratum-print-${process.pid}-${Date.now()}.html`)
    const page = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
    try {
      await writeFile(tmp, `<!doctype html><meta charset="utf-8"><style>@page{size:${width}px ${height}px;margin:0}html,body{margin:0;padding:0}svg{display:block}</style>${svg}`, 'utf8')
      await page.loadFile(tmp)
      const data = await page.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true, margins: { top: 0, right: 0, bottom: 0, left: 0 } })
      await writeFile(filePath, data)
      return filePath
    } finally {
      if (!page.isDestroyed()) page.destroy()
      await rm(tmp, { force: true })
    }
  }
}
