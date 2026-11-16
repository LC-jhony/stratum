import { app, BrowserWindow, dialog, Menu, nativeImage, shell, type MenuItemConstructorOptions } from 'electron'
import { createTranslator, type Locale } from '../core/i18n'
import { brandPath } from './brand'

/** Native About panel on macOS/Linux; a message box on Windows, which has none. */
const about = (detail: string) => {
  if (process.platform !== 'win32') return app.showAboutPanel()
  void dialog.showMessageBox({
    type: 'info', title: 'About Stratum', message: 'Stratum', detail,
    icon: nativeImage.createFromPath(brandPath('png/stratum-512.png')),
  })
}

/** Single menu template. On macOS and Linux (with a global-menu host) Electron exports it to the system menu bar. */
export function buildMenu(locale: Locale = 'en') {
  const t = createTranslator(locale)
  const isMac = process.platform === 'darwin'
  const send = (cmd: string, arg?: unknown) => () => BrowserWindow.getFocusedWindow()?.webContents.send('command', cmd, arg)
  const version = t('menu.version', { version: app.getVersion() })
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { label: t('menu.checkUpdates'), click: send('update.check') }, { label: t('menu.settings'), accelerator: 'Cmd+,', click: send('settings') }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] } as MenuItemConstructorOptions] : []),
    { label: t('menu.file'), submenu: [
      { label: t('menu.newDataSource'), accelerator: 'CmdOrCtrl+Alt+Shift+D', click: send('datasource.new') },
      { label: t('menu.newConsole'), accelerator: 'CmdOrCtrl+Shift+L', click: send('console.new') },
      { label: t('menu.openScript'), accelerator: 'CmdOrCtrl+O', click: send('script.open') },
      { label: t('menu.saveScript'), accelerator: 'CmdOrCtrl+S', click: send('script.save') },
      { label: t('menu.saveScriptAs'), accelerator: 'CmdOrCtrl+Shift+S', click: send('script.saveAs') },
      { label: t('menu.savedQueries'), accelerator: 'CmdOrCtrl+Alt+L', click: send('library.open') },
      { label: t('menu.saveQuery'), click: send('library.save') },
      { label: t('menu.openSqlite'), click: send('datasource.openSqlite') },
      { type: 'separator' },
      { label: t('menu.importConnections'), click: send('datasource.import') },
      { label: t('menu.exportConnections'), click: send('datasource.export') },
      { type: 'separator' },
      ...(isMac ? [{ role: 'close' } as MenuItemConstructorOptions] : [{ label: t('menu.settings'), accelerator: 'Ctrl+Alt+S', click: send('settings') } as MenuItemConstructorOptions, { role: 'quit', label: t('menu.quit') } as MenuItemConstructorOptions]),
    ] },
    { label: t('menu.edit'), submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' }, { label: t('menu.findAction'), accelerator: 'CmdOrCtrl+Shift+A', click: send('palette') }, { label: t('menu.searchObjects'), accelerator: 'CmdOrCtrl+Shift+O', click: send('object.search') }, { label: t('menu.formatSql'), accelerator: 'CmdOrCtrl+Shift+F', click: send('sql.format') }] },
    { label: t('menu.view'), submenu: [
      { label: t('menu.explorer'), accelerator: 'CmdOrCtrl+1', click: send('view.explorer') },
      { label: t('menu.toggleSideBar'), accelerator: 'CmdOrCtrl+B', click: send('view.sideBar') },
      { label: t('menu.toggleResults'), accelerator: 'CmdOrCtrl+4', click: send('view.results') },
      { type: 'separator' },
      { label: t('menu.colorTheme'), accelerator: 'CmdOrCtrl+K CmdOrCtrl+T', click: send('theme.color') },
      { label: t('menu.fileIconTheme'), click: send('theme.fileIcon') },
      { label: t('menu.productIconTheme'), click: send('theme.productIcon') },
      { type: 'separator' },
      { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' },
    ] },
    { label: t('menu.run'), submenu: [
      { label: t('menu.execute'), accelerator: 'CmdOrCtrl+Enter', click: send('run.statement') },
      { label: t('menu.executeScript'), accelerator: 'CmdOrCtrl+Shift+Enter', click: send('run.script') },
      { label: t('menu.explain'), accelerator: 'CmdOrCtrl+Shift+E', click: send('run.explain') },
      { label: t('menu.cancel'), accelerator: 'CmdOrCtrl+F2', click: send('run.cancel') },
    ] },
    { label: t('menu.database'), submenu: [
      { label: t('menu.reconnect'), accelerator: 'CmdOrCtrl+Alt+R', click: send('datasource.reconnect') },
      { label: t('menu.sessions'), click: send('session.monitor') },
      { label: t('menu.dashboard'), click: send('admin.open') },
      { label: t('menu.ai'), accelerator: 'CmdOrCtrl+Alt+A', click: send('ai.open') },
      { label: t('menu.newTable'), accelerator: 'CmdOrCtrl+Alt+N', click: send('designer.new') },
      { label: t('menu.importData'), accelerator: 'CmdOrCtrl+Shift+I', click: send('data.import') },
      { label: t('menu.driverManager'), click: send('drivers.open') },
      { type: 'separator' },
      { label: t('menu.refresh'), accelerator: 'CmdOrCtrl+Alt+Y', click: send('explorer.refresh') },
      { label: t('menu.diagram'), accelerator: 'CmdOrCtrl+Alt+U', click: send('erd.open') },
      { label: t('menu.submit'), accelerator: 'CmdOrCtrl+Alt+Enter', click: send('grid.submit') },
    ] },
    { role: 'windowMenu', label: t('menu.window') },
    { role: 'help', label: t('menu.help'), submenu: [
      { label: t('menu.checkUpdates'), click: send('update.check') },
      { label: t('menu.releaseNotes'), click: () => shell.openExternal('https://github.com/LC-jhony/stratum/releases') },
      { label: t('menu.extensions'), accelerator: 'CmdOrCtrl+Shift+X', click: send('extensions.open') },
      { type: 'separator' },
      { label: 'jdbc-adapter-server', click: () => shell.openExternal('https://github.com/database-client/jdbc-adapter-server') },
      { label: 'vscode-database-client', click: () => shell.openExternal('https://github.com/cweijan/vscode-database-client') },
      ...(isMac ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, { label: t('menu.about'), click: () => about(version) } as MenuItemConstructorOptions]),
    ] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
