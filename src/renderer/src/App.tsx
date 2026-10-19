import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ipc } from './ipc/client'
import logoDark from './assets/brand/stratum-logo-vertical-on-dark.svg'
import logoLight from './assets/brand/stratum-logo-vertical-on-light.svg'
import { setCompletionPrefs } from './monaco'
import { isSqlKind } from '../../core/kinds'
import { useWorkbench } from './store/workbench'
import { themes } from './theme/themeManager'
import { applyFontPrefs } from './theme/fonts'
import { CommandPalette, type PaletteItem } from './workbench/CommandPalette'
import { ConsoleEditor } from './features/console/ConsoleEditor'
import { DatasourceDialog } from './features/connections/DatasourceDialog'
import { ErdView } from './features/erd/ErdView'
import { Explorer } from './features/explorer/Explorer'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { Icon } from './ui/Icon'
import { ParamDialog } from './features/console/ParamDialog'
import { SettingsDialog } from './features/settings/SettingsDialog'
import { TableEditor } from './features/table/TableEditor'
import { Tabs } from './workbench/Tabs'

export function App() {
  const wb = useWorkbench()
  const { tabs, activeTab, live, connections, prefs, prefsLoaded, set } = wb
  const [width, setWidth] = useState(280)
  const active = tabs.find((t) => t.id === activeTab)
  const activeConn = connections.find((c) => c.id === active?.connectionId)
  const activeThemes = useSyncExternalStore(themes.subscribe.bind(themes), () => themes.active)
  const light = document.documentElement.dataset.theme === 'light'
  const sideRight = prefs['workbench.sideBar.position'] === 'right'
  useEffect(() => { void wb.load() }, [])
  useEffect(() => { setCompletionPrefs({ enabled: prefs['completion.enabled'], suggestOnSpace: prefs['completion.suggestOnSpace'], autoAlias: prefs['completion.autoAlias'], snippets: prefs['completion.snippets'], joinByForeignKey: prefs['completion.joinByForeignKey'], keywordCase: prefs['completion.keywordCase'] }) }, [prefs])
  useEffect(() => { applyFontPrefs(prefs) }, [prefs['editor.fontFamily']]) // Settings may change after mount; reapply the mono family live.
  // Keyed on the mode value: other prefs changes (side bar preview, param history…) must not re-apply a stale mode.
  useEffect(() => { if (prefsLoaded) void themes.applyMode(prefs['appearance.mode']) }, [prefsLoaded, prefs['appearance.mode']])

  const command = useCallback(async (cmd: string) => {
    const s = useWorkbench.getState(), cur = s.tabs.find((t) => t.id === s.activeTab)
    switch (cmd) {
      case 'datasource.new': return s.set({ dialog: {} })
      case 'datasource.openSqlite': { const f = await ipc.dialogs.pickFile([{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }]); if (!f) return; const c = { id: crypto.randomUUID(), name: f.split(/[\\/]/).pop()!, kind: 'sqlite' as const, filePath: f }; await s.saveConnection(c); void s.connect(c.id); return s.openConsole(c.id) }
      case 'console.new': return void s.openConsole(cur?.connectionId)
      case 'erd.open': return cur && isSqlKind(s.connections.find((c) => c.id === cur.connectionId)?.kind) ? s.openDiagram(cur.connectionId) : undefined
      case 'explorer.refresh': return void (cur && s.refresh(cur.connectionId))
      case 'view.results': return s.set({ showResults: !s.showResults })
      case 'palette': return s.set({ palette: 'actions' })
      case 'settings': return s.openSettings()
      case 'theme.color': return s.set({ palette: 'colorTheme' })
      case 'theme.fileIcon': return s.set({ palette: 'fileIconTheme' })
      case 'theme.productIcon': return s.set({ palette: 'productIconTheme' })
    }
  }, [])
  useEffect(() => ipc.onCommand((c) => void command(c)), [command])
  useEffect(() => { // Cmd/Ctrl+Shift+A is also bound in the native menu; this keeps it working when the menu is hidden.
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') { e.preventDefault(); void command('palette') } if (e.key === 'Escape') set({ palette: null, dialog: null }) }
    addEventListener('keydown', h); return () => removeEventListener('keydown', h)
  }, [command])

  const actions = useMemo<PaletteItem[]>(() => [
    { id: 'ds', label: 'New Data Source…', run: () => void command('datasource.new') },
    { id: 'sqlite', label: 'Open SQLite File…', run: () => void command('datasource.openSqlite') },
    { id: 'console', label: 'New Query Console', run: () => void command('console.new') },
    { id: 'erd', label: 'Show Diagram for Current Data Source', run: () => void command('erd.open') },
    { id: 'refresh', label: 'Refresh Database Explorer', run: () => void command('explorer.refresh') },
    { id: 'results', label: 'Toggle Results Panel', run: () => void command('view.results') },
    { id: 'prefs', label: 'Preferences: Open Settings', hint: ipc.platform === 'darwin' ? '⌘,' : 'Ctrl+Alt+S', run: () => void command('settings') },
    { id: 'ct', label: 'Preferences: Color Theme', hint: activeThemes.color?.entry.label, run: () => void command('theme.color') },
    { id: 'fi', label: 'Preferences: File Icon Theme', hint: activeThemes.fileIcon?.entry.label ?? 'none', run: () => void command('theme.fileIcon') },
    { id: 'pi', label: 'Preferences: Product Icon Theme', hint: activeThemes.productIcon?.entry.label ?? 'Codicons', run: () => void command('theme.productIcon') },
  ], [command, activeThemes])

  const startResize = (e: React.MouseEvent) => { const x0 = e.clientX, w0 = width, right = sideRight; const mm = (m: MouseEvent) => { const dx = m.clientX - x0; setWidth(Math.min(560, Math.max(200, w0 + (right ? -dx : dx)))) }; const up = () => { removeEventListener('mousemove', mm); removeEventListener('mouseup', up) }; addEventListener('mousemove', mm); addEventListener('mouseup', up) }

  return (
    <div className={`workbench${sideRight ? ' right' : ''}`}>
      <nav className="stripe" aria-label="Tool windows">
        <button className="on" data-label="Database Explorer (⌘/Ctrl+1)" aria-label="Database Explorer"><Icon id="database" /></button>
        <button data-label="New Query Console" aria-label="New Query Console" onClick={() => void command('console.new')}><Icon id="terminal" /></button>
        <button data-label="Diagram" aria-label="Diagram" onClick={() => void command('erd.open')}><Icon id="type-hierarchy" /></button>
        <span className="grow" />
        <button data-label="Find Action (⌘/Ctrl+Shift+A)" aria-label="Find Action" onClick={() => command('palette')}><Icon id="search" /></button>
        <button data-label="Settings (Ctrl+Alt+S)" aria-label="Settings" onClick={() => command('settings')}><Icon id="settings-gear" /></button>
      </nav>
      <div className="side" style={{ width }}><Explorer /></div>
      <div className="sash" onMouseDown={startResize} />
      <main className="editor-area">
        <Tabs />
        <div className="content">
          {!tabs.length && (
            <div className="welcome">
              <img className="logo" src={light ? logoLight : logoDark} alt="Stratum" draggable={false} />
              <p>Connect a data source to browse schemas, run queries, edit data and explore ER diagrams.</p>
              <div className="actions"><button className="primary" onClick={() => command('datasource.new')}>New Data Source…</button><button onClick={() => command('datasource.openSqlite')}>Open SQLite File…</button></div>
              <dl><dt>Find Action</dt><dd>{ipc.platform === 'darwin' ? '⇧⌘A' : 'Ctrl+Shift+A'}</dd><dt>Run statement</dt><dd>{ipc.platform === 'darwin' ? '⌘↵' : 'Ctrl+Enter'}</dd></dl>
            </div>
          )}
          {tabs.map((t) => (
            <div key={t.id} className="tab-body" style={{ display: t.id === activeTab ? 'flex' : 'none' }}>
              <ErrorBoundary>
                {t.type === 'console' ? <ConsoleEditor tab={t} visible={t.id === activeTab} /> : t.type === 'table' ? <TableEditor tab={t} visible={t.id === activeTab} /> : <ErdView tab={t} visible={t.id === activeTab} />}
              </ErrorBoundary>
            </div>
          ))}
        </div>
      </main>
      <footer className="app-status">
        <span className="conn"><Icon id={activeConn && live[activeConn.id]?.status === 'ready' ? 'pass-filled' : 'circle-slash'} /><span className="conn-name">{activeConn ? `${activeConn.name}${live[activeConn.id]?.version ? ' · ' + live[activeConn.id]!.version : ''}` : 'No data source'}</span></span>
        <span className="grow" />
        <button onClick={() => command('theme.color')} title="Select color theme"><Icon id="symbol-color" /> <span className="theme-label">{activeThemes.color?.entry.label}</span></button>
      </footer>
      <CommandPalette actions={actions} />
      {wb.dialog && <DatasourceDialog key={wb.dialog.editing?.id ?? 'new'} />}
      {wb.settingsOpen && <SettingsDialog />}
      <ParamDialog />
    </div>
  )
}
