import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ipc } from './ipc/client'
import logoDark from './assets/brand/stratum-logo-vertical-on-dark.svg'
import logoLight from './assets/brand/stratum-logo-vertical-on-light.svg'
import { setCompletionPrefs } from './monaco'
import { isSqlKind } from '../../core/kinds'
import { parseWorkspace, serializeWorkspace, WORKSPACE_STORAGE_KEY } from '../../core/workspace'
import { useWorkbench } from './store/workbench'
import { themes } from './theme/themeManager'
import { applyFontPrefs } from './theme/fonts'
import { applyAppearance } from './theme/appearance'
import { CommandPalette, type PaletteItem } from './workbench/CommandPalette'
import { ConsoleEditor } from './features/console/ConsoleEditor'
import { DatasourceDialog } from './features/connections/DatasourceDialog'
import { ErdView } from './features/erd/ErdView'
import { Explorer } from './features/explorer/Explorer'
import { SessionMonitorDialog } from './features/admin/SessionMonitorDialog'
import { QueryLibraryDialog } from './features/library/QueryLibraryDialog'
import { ObjectSearchDialog } from './features/search/ObjectSearchDialog'
import { UpdateStatus } from './features/updates/UpdateStatus'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { Icon } from './ui/Icon'
import { ParamDialog } from './features/console/ParamDialog'
import { SettingsDialog } from './features/settings/SettingsDialog'
import { TableEditor } from './features/table/TableEditor'
import { Tabs } from './workbench/Tabs'
import { TitleBar } from './workbench/TitleBar'

export function App() {
  const wb = useWorkbench()
  const { tabs, activeTab, live, connections, prefs, prefsLoaded, history, set } = wb
  const [width, setWidth] = useState(280)
  const active = tabs.find((t) => t.id === activeTab)
  const activeConn = connections.find((c) => c.id === active?.connectionId)
  const activeThemes = useSyncExternalStore(themes.subscribe.bind(themes), () => themes.active)
  const light = document.documentElement.dataset.theme === 'light'
  const sideRight = prefs['workbench.sideBar.position'] === 'right'
  const sideVisible = prefs['workbench.sideBar.visible']
  const restored = useRef(false)
  // Restore the previous SQL consoles after connections load; corruption or deleted sources are ignored.
  useEffect(() => {
    let live = true
    void wb.load().then(() => {
      if (!live) return
      const s = useWorkbench.getState()
      if (s.prefs['workbench.restoreTabs']) {
        try {
          const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY)
          const snapshot = parseWorkspace(raw, s.connections.map((c) => c.id))
          if (snapshot) s.restoreWorkspace(snapshot)
          else if (raw) localStorage.removeItem(WORKSPACE_STORAGE_KEY)
        } catch { /* storage can be unavailable; start with an empty workbench */ }
      }
      restored.current = true
    }).catch((e) => console.error('loading workspace:', e))
    return () => { live = false }
  }, [])
  // Persist only SQL consoles (never results or sessions). Writes are debounced while typing.
  useEffect(() => {
    const save = () => {
      if (!restored.current) return
      const s = useWorkbench.getState()
      try {
        if (!s.prefs['workbench.restoreTabs']) { localStorage.removeItem(WORKSPACE_STORAGE_KEY); return }
        const raw = serializeWorkspace(
          s.tabs.filter((t) => t.type === 'console').map((t) => ({ id: t.id, title: t.title, connectionId: t.connectionId, sql: t.sql })),
          s.activeTab,
        )
        if (raw) localStorage.setItem(WORKSPACE_STORAGE_KEY, raw)
        else localStorage.removeItem(WORKSPACE_STORAGE_KEY)
      } catch { /* quota or private mode: restoring is a convenience, never a failure */ }
    }
    let timer: number | undefined
    const off = useWorkbench.subscribe((s, prev) => {
      if (!restored.current || (s.tabs === prev.tabs && s.activeTab === prev.activeTab)) return
      if (timer) clearTimeout(timer)
      timer = window.setTimeout(save, 500)
    })
    addEventListener('beforeunload', save)
    return () => { off(); removeEventListener('beforeunload', save); if (timer) clearTimeout(timer); save() }
  }, [])
  useEffect(() => {
    let off: (() => void) | undefined
    let live = true
    void wb.initUpdates().then((f) => { if (live) off = f; else f() })
    return () => { live = false; off?.() }
  }, [])
  // Sessions closed by the idle sweep or lost keep-alive must disappear from the Explorer.
  useEffect(() => ipc.connections.onState((state) => useWorkbench.getState().sessionState(state)), [])
  useEffect(() => { setCompletionPrefs({ enabled: prefs['completion.enabled'], suggestOnSpace: prefs['completion.suggestOnSpace'], autoAlias: prefs['completion.autoAlias'], snippets: prefs['completion.snippets'], joinByForeignKey: prefs['completion.joinByForeignKey'], keywordCase: prefs['completion.keywordCase'] }) }, [prefs])
  useEffect(() => { applyFontPrefs(prefs) }, [prefs['editor.fontFamily']]) // Settings may change after mount; reapply the mono family live.
  // UI scale and family: Settings previews them through previewPrefs, so this also drives the live preview.
  useEffect(() => { applyAppearance(prefs) }, [prefs])
  // Keyed on the mode value: other prefs changes (side bar preview, param history…) must not re-apply a stale mode.
  useEffect(() => { if (prefsLoaded) void themes.applyMode(prefs['appearance.mode']) }, [prefsLoaded, prefs['appearance.mode']])

  const command = useCallback(async (cmd: string) => {
    const s = useWorkbench.getState(), cur = s.tabs.find((t) => t.id === s.activeTab)
    switch (cmd) {
      case 'datasource.new': return s.set({ dialog: {} })
      case 'datasource.openSqlite': { const f = await ipc.dialogs.pickFile([{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }]); if (!f) return; const c = { id: crypto.randomUUID(), name: f.split(/[\\/]/).pop()!, kind: 'sqlite' as const, filePath: f }; await s.saveConnection(c); void s.connect(c.id); return s.openConsole(c.id) }
      case 'console.new': return void s.openConsole(cur?.connectionId)
      case 'object.search': return s.set({ objectSearchOpen: true })
      case 'library.open': return s.set({ libraryOpen: true })
      case 'session.monitor': {
        const kind = s.connections.find((c) => c.id === cur?.connectionId)?.kind
        if (cur && (kind === 'postgres' || kind === 'mysql')) s.set({ sessionMonitor: cur.connectionId })
        else window.alert('The session monitor is available for PostgreSQL and MySQL data sources.')
        return
      }
      case 'erd.open': return cur && isSqlKind(s.connections.find((c) => c.id === cur.connectionId)?.kind) ? s.openDiagram(cur.connectionId) : undefined
      case 'explorer.refresh': return void (cur && s.refresh(cur.connectionId))
      case 'datasource.reconnect': return void (cur && s.reconnect(cur.connectionId))
      case 'view.explorer': {
        // VS Code's Cmd/Ctrl+1: reveal the side bar and put the caret in the tree filter.
        if (!s.prefs['workbench.sideBar.visible']) void s.savePrefs({ 'workbench.sideBar.visible': true })
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.side .filter input')?.focus())
        return
      }
      case 'view.sideBar': return void s.savePrefs({ 'workbench.sideBar.visible': !s.prefs['workbench.sideBar.visible'] })
      case 'view.results': return s.set({ showResults: !s.showResults })
      case 'palette': return s.set({ palette: 'actions' })
      case 'settings': return s.openSettings()
      case 'theme.color': return s.set({ palette: 'colorTheme' })
      case 'theme.fileIcon': return s.set({ palette: 'fileIconTheme' })
      case 'theme.productIcon': return s.set({ palette: 'productIconTheme' })
      case 'update.check': return void (s.showUpdates(), s.checkUpdates(false))
      case 'update.open': return s.showUpdates()
      case 'sql.format': { dispatchEvent(new Event('stratum:format')); return }
      case 'run.explain': { dispatchEvent(new Event('stratum:explain')); return }
      case 'library.save': { dispatchEvent(new Event('stratum:saveQuery')); return }
    }
  }, [])
  useEffect(() => ipc.onCommand((c) => void command(c)), [command])
  useEffect(() => { // Cmd/Ctrl+Shift+A is also bound in the native menu; this keeps it working when the menu is hidden.
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.shiftKey && e.key.toLowerCase() === 'a') { e.preventDefault(); void command('palette') }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); void command('object.search') }
      else if (mod && e.altKey && e.key.toLowerCase() === 'l') { e.preventDefault(); void command('library.open') }
      else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); void command('view.sideBar') }
      else if (mod && !e.shiftKey && !e.altKey && e.key === '1') { e.preventDefault(); void command('view.explorer') }
      if (e.key === 'Escape') set({ palette: null, dialog: null, objectSearchOpen: false, libraryOpen: false, sessionMonitor: undefined })
    }
    // Capture: Monaco consumes some modified keys before they reach the window bubble phase.
    addEventListener('keydown', h, true); return () => removeEventListener('keydown', h, true)
  }, [command])
  // The native title bar is hidden, but the OS still uses the document title for the window list.
  useEffect(() => { document.title = active ? `${active.title} — Stratum` : 'Stratum' }, [active?.title])

  const actions = useMemo<PaletteItem[]>(() => {
    const recent = activeConn ? (history[activeConn.id] ?? []).slice(0, 6) : []
    return [
      { id: 'ds', label: 'New Data Source…', run: () => void command('datasource.new') },
      { id: 'sqlite', label: 'Open SQLite File…', run: () => void command('datasource.openSqlite') },
      { id: 'console', label: 'New Query Console', run: () => void command('console.new') },
      { id: 'search-objects', label: 'Search Database Objects…', hint: ipc.platform === 'darwin' ? '⇧⌘O' : 'Ctrl+Shift+O', run: () => void command('object.search') },
      { id: 'library', label: 'Open Saved Queries…', hint: ipc.platform === 'darwin' ? '⌥⌘L' : 'Ctrl+Alt+L', run: () => void command('library.open') },
      { id: 'sessions', label: 'Sessions & Locks…', run: () => void command('session.monitor') },
      { id: 'erd', label: 'Show Diagram for Current Data Source', run: () => void command('erd.open') },
      { id: 'refresh', label: 'Refresh Database Explorer', run: () => void command('explorer.refresh') },
      { id: 'format', label: 'Format SQL', hint: ipc.platform === 'darwin' ? '⇧⌘F' : 'Ctrl+Shift+F', run: () => void command('sql.format') },
      { id: 'explain', label: 'Explain Execution Plan', hint: ipc.platform === 'darwin' ? '⇧⌘E' : 'Ctrl+Shift+E', run: () => void command('run.explain') },
      { id: 'save-query', label: 'Save Query to Library…', run: () => void command('library.save') },
      { id: 'side', label: 'View: Toggle Side Bar', hint: ipc.platform === 'darwin' ? '⌘B' : 'Ctrl+B', run: () => void command('view.sideBar') },
      { id: 'explorer', label: 'View: Focus Database Explorer', hint: ipc.platform === 'darwin' ? '⌘1' : 'Ctrl+1', run: () => void command('view.explorer') },
      { id: 'results', label: 'Toggle Results Panel', run: () => void command('view.results') },
      { id: 'prefs', label: 'Preferences: Open Settings', hint: ipc.platform === 'darwin' ? '⌘,' : 'Ctrl+Alt+S', run: () => void command('settings') },
      { id: 'ct', label: 'Preferences: Color Theme', hint: activeThemes.color?.entry.label, run: () => void command('theme.color') },
      { id: 'fi', label: 'Preferences: File Icon Theme', hint: activeThemes.fileIcon?.entry.label ?? 'none', run: () => void command('theme.fileIcon') },
      { id: 'pi', label: 'Preferences: Product Icon Theme', hint: activeThemes.productIcon?.entry.label ?? 'Codicons', run: () => void command('theme.productIcon') },
      { id: 'updates', label: 'Help: Check for Updates…', run: () => void command('update.check') },
      ...recent.map((sql, i) => ({
        id: `recent-${i}`,
        label: `Recent query: ${sql.replace(/\s+/g, ' ').slice(0, 70)}`,
        hint: 'Open in console',
        run: () => { if (activeConn) useWorkbench.getState().openConsole(activeConn.id, sql) },
      })),
    ]
  }, [command, activeThemes, activeConn, history])

  const startResize = (e: React.MouseEvent) => { const x0 = e.clientX, w0 = width, right = sideRight; const mm = (m: MouseEvent) => { const dx = m.clientX - x0; setWidth(Math.min(560, Math.max(200, w0 + (right ? -dx : dx)))) }; const up = () => { removeEventListener('mousemove', mm); removeEventListener('mouseup', up) }; addEventListener('mousemove', mm); addEventListener('mouseup', up) }

  return (
    <div className={`workbench${sideRight ? ' right' : ''}${sideVisible ? '' : ' side-hidden'}`}>
      <TitleBar title={active?.title} light={light} onCommand={(cmd) => void command(cmd)} />
      <nav className="stripe" aria-label="Tool windows">
        <button className={sideVisible ? 'on' : ''} data-label={sideVisible ? 'Hide Database Explorer (⌘/Ctrl+B)' : 'Show Database Explorer (⌘/Ctrl+B)'} aria-label="Database Explorer" aria-pressed={sideVisible} onClick={() => void command('view.sideBar')}><Icon id="database" /></button>
        <button data-label="New Query Console" aria-label="New Query Console" onClick={() => void command('console.new')}><Icon id="terminal" /></button>
        <button data-label="Diagram" aria-label="Diagram" onClick={() => void command('erd.open')}><Icon id="type-hierarchy" /></button>
        <span className="grow" />
        <button data-label="Find Action (⌘/Ctrl+Shift+A)" aria-label="Find Action" onClick={() => command('palette')}><Icon id="search" /></button>
        <button data-label="Settings (Ctrl+Alt+S)" aria-label="Settings" onClick={() => command('settings')}><Icon id="settings-gear" /></button>
      </nav>
      <div className="side" style={{ width }} aria-hidden={!sideVisible}><Explorer /></div>
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
                {t.type === 'console' ? <ConsoleEditor tab={t} visible={t.id === activeTab} /> : t.type === 'table' ? <TableEditor tab={t} visible={t.id === activeTab} /> : t.type === 'diagram' ? <ErdView tab={t} visible={t.id === activeTab} /> : null}
              </ErrorBoundary>
            </div>
          ))}
        </div>
      </main>
      <footer className="app-status">
        <span className="status-brand">Stratum</span>
        <span className="status-sep" />
        <span className="conn"><Icon id={activeConn && live[activeConn.id]?.status === 'ready' ? 'pass-filled' : 'circle-slash'} /><span className="conn-name">{activeConn ? `${activeConn.name}${live[activeConn.id]?.version ? ' · ' + live[activeConn.id]!.version : ''}` : 'No data source'}</span></span>
        {activeConn && wb.transactions[activeConn.id]?.open && <span className="status-tx" title="Open transaction"><Icon id="circle-check" />TX</span>}
        <span className="grow" />
        <UpdateStatus />
        <button onClick={() => command('theme.color')} title="Select color theme"><Icon id="symbol-color" /> <span className="theme-label">{activeThemes.color?.entry.label}</span></button>
      </footer>
      <CommandPalette actions={actions} />
      {wb.dialog && <DatasourceDialog key={wb.dialog.editing?.id ?? 'new'} />}
      {wb.settingsOpen && <SettingsDialog />}
      <ParamDialog />
      <ObjectSearchDialog />
      <QueryLibraryDialog />
      <SessionMonitorDialog />
    </div>
  )
}
