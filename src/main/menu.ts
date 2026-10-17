import { app, BrowserWindow, dialog, Menu, nativeImage, shell, type MenuItemConstructorOptions } from 'electron'
import { brandPath } from './brand'

/** Native About panel on macOS/Linux; a message box on Windows, which has none. */
const about = () => {
  if (process.platform !== 'win32') return app.showAboutPanel()
  void dialog.showMessageBox({
    type: 'info', title: 'About Stratum', message: 'Stratum', detail: `Version ${app.getVersion()}`,
    icon: nativeImage.createFromPath(brandPath('png/stratum-512.png')),
  })
}

/** Single menu template. On macOS and Linux (with a global-menu host) Electron exports it to the system menu bar. */
export function buildMenu() {
  const isMac = process.platform === 'darwin'
  const send = (cmd: string, arg?: unknown) => () => BrowserWindow.getFocusedWindow()?.webContents.send('command', cmd, arg)
  const t: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Settings…', accelerator: 'Cmd+,', click: send('settings') }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] } as MenuItemConstructorOptions] : []),
    { label: 'File', submenu: [
      { label: 'New Data Source…', accelerator: 'CmdOrCtrl+Alt+Shift+D', click: send('datasource.new') },
      { label: 'New Query Console', accelerator: 'CmdOrCtrl+Shift+L', click: send('console.new') },
      { label: 'Open SQLite File…', click: send('datasource.openSqlite') },
      { type: 'separator' },
      ...(isMac ? [{ role: 'close' } as MenuItemConstructorOptions] : [{ label: 'Settings…', accelerator: 'Ctrl+Alt+S', click: send('settings') } as MenuItemConstructorOptions, { role: 'quit' } as MenuItemConstructorOptions]),
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' }, { label: 'Find Action…', accelerator: 'CmdOrCtrl+Shift+A', click: send('palette') }] },
    { label: 'View', submenu: [
      { label: 'Database Explorer', accelerator: 'CmdOrCtrl+1', click: send('view.explorer') },
      { label: 'Toggle Results Panel', accelerator: 'CmdOrCtrl+4', click: send('view.results') },
      { type: 'separator' },
      { label: 'Color Theme…', accelerator: 'CmdOrCtrl+K CmdOrCtrl+T', click: send('theme.color') },
      { label: 'File Icon Theme…', click: send('theme.fileIcon') },
      { label: 'Product Icon Theme…', click: send('theme.productIcon') },
      { type: 'separator' },
      { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' },
    ] },
    { label: 'Run', submenu: [
      { label: 'Execute', accelerator: 'CmdOrCtrl+Enter', click: send('run.statement') },
      { label: 'Execute Script', accelerator: 'CmdOrCtrl+Shift+Enter', click: send('run.script') },
      { label: 'Cancel', accelerator: 'CmdOrCtrl+F2', click: send('run.cancel') },
    ] },
    { label: 'Database', submenu: [
      { label: 'Refresh', accelerator: 'CmdOrCtrl+Alt+Y', click: send('explorer.refresh') },
      { label: 'Show Diagram', accelerator: 'CmdOrCtrl+Alt+U', click: send('erd.open') },
      { label: 'Submit Changes', accelerator: 'CmdOrCtrl+Alt+Enter', click: send('grid.submit') },
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'jdbc-adapter-server', click: () => shell.openExternal('https://github.com/database-client/jdbc-adapter-server') },
      { label: 'vscode-database-client', click: () => shell.openExternal('https://github.com/cweijan/vscode-database-client') },
      ...(isMac ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, { label: 'About Stratum', click: about } as MenuItemConstructorOptions]),
    ] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(t))
}
