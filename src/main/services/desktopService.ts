import { app, BrowserWindow, dialog, shell } from 'electron'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SaveFilter } from '../../shared/ipc'

/** Larger imports would freeze the renderer while the parser builds the statement list. */
const MAX_TEXT_BYTES = 64 * 1024 * 1024
/** `@include` files are expanded into the running script; 16 MB is already an enormous script. */
const MAX_INCLUDE_BYTES = 16 * 1024 * 1024

/** Native dialogs, file saves and PDF rendering. Keeps Electron UI plumbing out of IPC routers. */
export class DesktopService {
  /** Paths the user opened or chose in a dialog; only these may be overwritten without asking again. */
  private writable = new Set<string>()

  constructor(private window: () => BrowserWindow | null) {}

  /** True when `file` is a path the user already granted through a native dialog in this session. */
  private canOverwrite(file: string): boolean {
    try { return this.writable.has(path.resolve(file)) } catch { return false }
  }

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

  /**
   * Read a text file named by an `@include` command. Relative paths resolve next to the including
   * file, or inside the user's Documents folder for the top-level script (which has no path yet).
   * The path comes from the user's own script; the renderer never receives a directory listing.
   */
  async readText(file: string, from?: string): Promise<{ path: string; name: string; content: string }> {
    const requested = file.trim()
    if (!requested || requested.length > 4000 || requested.includes('\0')) throw new Error('Invalid @include path.')
    const home = app.getPath('home')
    const expanded = /^~[\\/]/.test(requested) ? path.join(home, requested.slice(2)) : requested === '~' ? home : requested
    const full = path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(from ? path.dirname(from) : app.getPath('documents'), expanded)
    let info
    try { info = await stat(full) }
    catch { throw new Error(`Cannot include "${full}": the file does not exist.`) }
    if (!info.isFile()) throw new Error(`Cannot include "${full}": it is not a file.`)
    if (info.size > MAX_INCLUDE_BYTES) {
      throw new Error(`Cannot include "${full}": the file is ${(info.size / 1048576).toFixed(1)} MB; the limit is 16 MB.`)
    }
    const content = await readFile(full, 'utf8')
    return { path: full, name: path.basename(full), content: content.replace(/^\uFEFF/, '') }
  }

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
    this.writable.add(path.resolve(file))
    return { path: file, name: path.basename(file), content: content.replace(/^\uFEFF/, '') }
  }

  /** Open a CSV/JSON/SQL/XLSX file for the import wizard; binary workbooks travel as base64. */
  async openImport(filters?: SaveFilter[]): Promise<{ path: string; name: string; size: number; text?: string; base64?: string } | null> {
    const win = this.window()
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openFile'], filters })
    const file = filePaths[0]
    if (canceled || !file) return null
    const info = await stat(file)
    if (info.size > MAX_TEXT_BYTES) {
      throw new Error(`${path.basename(file)} is ${(info.size / 1048576).toFixed(1)} MB; the import limit is 64 MB.`)
    }
    const name = path.basename(file), binary = /\.(xlsx|xlsm|xls)$/i.test(name)
    return {
      path: file, name, size: info.size,
      ...(binary
        ? { base64: (await readFile(file)).toString('base64') }
        : { text: (await readFile(file, 'utf8')).replace(/^\uFEFF/, '') }),
    }
  }

  async saveFile(defaultName: string, content: string, filters?: SaveFilter[], encoding: BufferEncoding = 'utf8'): Promise<string | null> {
    const win = this.window()
    if (!win) return null
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters })
    if (canceled || !filePath) return null
    await writeFile(filePath, content, encoding)
    this.writable.add(path.resolve(filePath))
    return filePath
  }

  /**
   * Save a script file. A path the user already opened or chose may be overwritten directly;
   * anything else goes through the native save dialog, so the renderer can never write outside
   * a location the user granted.
   */
  async writeText(file: string | undefined, content: string, defaultName = 'query.sql'): Promise<string | null> {
    if (typeof content !== 'string' || content.length > MAX_TEXT_BYTES) {
      throw new Error('The script is too large to save (64 MB limit).')
    }
    const win = this.window()
    if (!win) return null
    let target = file && this.canOverwrite(file) ? path.resolve(file) : undefined
    if (!target) {
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: file || defaultName,
        filters: [{ name: 'SQL script', extensions: ['sql', 'ddl', 'pgsql', 'mysql'] }],
      })
      if (canceled || !filePath) return null
      target = filePath
    }
    await writeFile(target, content, 'utf8')
    this.writable.add(path.resolve(target))
    return target
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
