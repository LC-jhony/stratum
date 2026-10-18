import { app, BrowserWindow, Menu, nativeTheme, net, protocol, shell, Tray } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { brandPath } from './brand'
import { registerIpc } from './ipc'
import { buildMenu } from './menu'
import { ConnectionManager } from './services/connectionManager'
import { JdbcSidecar, type JdbcRuntime } from './services/jdbcSidecar'
import { ConnectionStore, JsonStore } from './services/store'
import { ThemeService } from './services/themeService'

protocol.registerSchemesAsPrivileged([{ scheme: 'stratum-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

// Linux global menu (DBusMenu / appmenu) is exported automatically from Menu.setApplicationMenu.
app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')

let win: BrowserWindow | null = null
let tray: Tray | null = null
/** Rebuilds the tray menu so its item reflects the window visibility; set once the tray exists. */
let syncTray: (() => void) | null = null
const resourcePath = (...p: string[]) => (app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(app.getAppPath(), ...p))

async function main() {
  await app.whenReady()
  if (process.platform !== 'win32') app.setAboutPanelOptions({ applicationName: 'Stratum', applicationVersion: app.getVersion(), iconPath: brandPath('png/stratum-512.png') })
  const data = app.getPath('userData')
  const connections = new ConnectionStore(new JsonStore(path.join(data, 'connections.json'), { connections: [] }))
  const settings = new JsonStore<Record<string, unknown>>(path.join(data, 'settings.json'), {})
  const jdbc: JdbcRuntime = { javaHome: process.env.JAVA_HOME }
  /** Applies jdbc.* settings into the runtime mirror; returns true when something changed. */
  const applyJdbcSettings = (s: Record<string, unknown>): boolean => {
    let changed = false
    const jar = s['jdbc.jarPath']; if (typeof jar === 'string') { const v = jar || undefined; if (v !== jdbc.jar) { jdbc.jar = v; changed = true } }
    const port = s['jdbc.port']; if (typeof port === 'number' && port > 0 && port !== jdbc.port) { jdbc.port = port; changed = true }
    const home = s['jdbc.javaHome']; if (typeof home === 'string') { const v = home || process.env.JAVA_HOME; if (v !== jdbc.javaHome) { jdbc.javaHome = v; changed = true } }
    return changed
  }
  const initial = await settings.read()
  applyJdbcSettings(initial)
  // Native chrome (the in-window menu bar, popup menus, dialogs) follows the selected color theme, like VS Code.
  nativeTheme.themeSource = initial.colorScheme === 'light' || initial.colorScheme === 'dark' ? initial.colorScheme : 'system'
  const sidecar = new JdbcSidecar(() => ({ ...jdbc, jar: jdbc.jar ?? process.env.STRATUM_JDBC_JAR ?? resourcePath('jdbc-adapter', 'jdbc-adapter-server.jar') }))
  const manager = new ConnectionManager(connections, sidecar)
  const themes = new ThemeService(resourcePath('themes'), path.join(data, 'themes'))

  protocol.handle('stratum-asset', async (req) => {
    const file = path.normalize(decodeURIComponent(new URL(req.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'))
    if (![...themes.allowedRoots].some((r) => file.startsWith(r + path.sep))) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).toString())
  })

  registerIpc({
    connections, manager, themes, settings, window: () => win,
    onSettingsChanged: (patch) => {
      if (applyJdbcSettings(patch)) sidecar.stop()
      if (patch.colorScheme === 'light' || patch.colorScheme === 'dark' || patch.colorScheme === 'system') nativeTheme.themeSource = patch.colorScheme
      if (typeof patch.windowBackground === 'string' && patch.windowBackground && win && !win.isDestroyed()) win.setBackgroundColor(patch.windowBackground)
    },
  })
  buildMenu()

  const create = async () => {
    const prefs = await settings.read()
    win = new BrowserWindow({
      width: 1440, height: 900, minWidth: 820, minHeight: 560, show: false,
      icon: brandPath('png/stratum-512.png'),
      backgroundColor: (prefs.windowBackground as string) ?? '#171717',
      // On Linux the in-window menu bar is drawn with the system GTK colours, so it cannot follow the app theme
      // (a dark GTK theme keeps it dark on light themes). Hide it like VS Code does; Alt reveals it.
      autoHideMenuBar: process.platform === 'linux',
      webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    })
    if (process.platform === 'linux') win.setMenuBarVisibility(false)
    win.once('ready-to-show', () => win?.show())
    win.on('show', () => syncTray?.())
    win.on('hide', () => syncTray?.())
    win.on('closed', () => syncTray?.())
    win.webContents.setWindowOpenHandler(({ url }) => {
      // Only real web/mail links are handed to the OS: a theme file or future content must not be able
      // to launch arbitrary schemes (file://, custom protocol handlers) through window.open.
      if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    // The workbench never navigates away from its own page; block any attempt so a crafted link cannot
    // replace the app view. Same-URL events (Vite's full reload in `npm run dev`) are left alone.
    win.webContents.on('will-navigate', (e, url) => { if (url !== win?.webContents.getURL()) e.preventDefault() })
    if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL)
    else await win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: process.env.STRATUM_SMOKE ? { smoke: '1' } : undefined })
  }
  await create()
  /** System tray: click toggles the window (macOS opens the menu instead, like other menu-bar apps). */
  const createTray = () => {
    tray = new Tray(brandPath(process.platform === 'darwin' ? 'tray/trayTemplate.png' : 'tray/tray-32.png'))
    tray.setToolTip('Stratum')
    const visible = () => !!win && !win.isDestroyed() && win.isVisible()
    const toggle = () => {
      if (!win || win.isDestroyed()) return void create()
      if (win.isVisible()) win.hide()
      else { win.show(); win.focus() }
    }
    if (process.platform !== 'darwin') tray.on('click', toggle)
    syncTray = () => tray?.setContextMenu(Menu.buildFromTemplate([
      { label: visible() ? 'Hide Stratum' : 'Show Stratum', click: toggle },
      { type: 'separator' },
      { label: 'Quit Stratum', role: 'quit' },
    ]))
    syncTray()
  }
  // A tray host (libappindicator / StatusNotifier) is not guaranteed, so never fail startup over it.
  try { createTray() } catch (e) { console.warn('tray unavailable:', e) }
  if (process.env.STRATUM_SMOKE) { // CI hook: run steps (separated by //--- ) inside the renderer, screenshot after each, exit
    const errors: string[] = [], results: unknown[] = []
    win!.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg) })
    const steps = readFileSync(process.env.STRATUM_SMOKE, 'utf8').split(/^\/\/---.*$/m)
    for (const [i, step] of steps.entries()) {
      results.push(await win!.webContents.executeJavaScript(step).catch((e) => ({ crash: String(e) })))
      if (process.env.STRATUM_SHOTS) {
        try { writeFileSync(path.join(process.env.STRATUM_SHOTS, `shot-${i}.png`), (await win!.webContents.capturePage()).toPNG()) }
        catch { /* a transient capture failure must not abort the run */ }
      }
    }
    console.log('SMOKE', JSON.stringify({ results, errors }))
    app.exit(0)
  }
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) void create() })
  app.on('before-quit', () => void manager.closeAll())
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}
app.on('second-instance', () => {
  // A second launch (desktop icon, tray, CLI) focuses the running window instead of starting a rival
  // process: two instances would race the JSON stores (last write wins) and duplicate the tray icon.
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

void (process.env.STRATUM_SMOKE || app.requestSingleInstanceLock() ? main() : app.quit())
