import { app, BrowserWindow, dialog, shell } from 'electron'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SaveFilter } from '../../shared/ipc'

/** Larger imports would freeze the renderer while the parser builds the statement list. */
const MAX_TEXT_BYTES = 64 * 1024 * 1024

/** Native dialogs, file saves and PDF rendering. Keeps Electron UI plumbing out of IPC routers. */
export class DesktopService {
  constructor(private window: () => BrowserWindow | null) {}

  async pickFile(filters?: SaveFilter[]): Promise<string | undefined> {
    const win = this.window()
    if (!win) return undefined
    return (await dialog.showOpenDialog(win, { properties: ['openFile'], filters })).filePaths[0]
  }

  /** Multi-selection open dialog (driver JARs); an empty array means the user cancelled. */
  async pickFiles(filters?: SaveFilter[]): Promise<string[]> {
    const win = this.window()
    if (!win) return []
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters })
    return canceled ? [] : filePaths
  }

  /** Show a file in the OS file manager (Driver Manager's "Reveal"). */
  reveal(path: string): void { shell.showItemInFolder(path) }

  /** Open a folder in the OS file manager. */
  async openFolder(dir: string): Promise<void> { await shell.openPath(dir) }

  async openText(filters?: SaveFilter[]): Promise<{ path: string; name: string; content: string } | null> {
    const win = this.window()
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openFile'], filters })
    const file = filePaths[0]
    if (canceled || !file) return null
    const { size } = await stat(file)
    if (size > MAX_TEXT_BYTES) {
      throw new Error(`${path.basename(file)} is ${(size / 1048576).toFixed(1)} MB; the import limit is 64 MB.`)
    }
    const content = await readFile(file, 'utf8')
    return { path: file, name: path.basename(file), content: content.replace(/^\uFEFF/, '') }
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
