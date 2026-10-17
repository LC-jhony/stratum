import { useEffect, useRef, useState } from 'react'
import { statementAt, splitStatements } from '../../../shared/sql'
import { connectionDialect } from '../../../shared/dialects'
import { ensureMonaco, setCompletionModel, syncMonacoTheme } from '../monaco'
import { themes } from '../theme/themeManager'
import { monoFontStack } from '../theme/fonts'
import { useWorkbench, type ConsoleTab } from '../store/workbench'
import { Icon } from './Icon'
import { ResultsPane } from './ResultsPane'
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api'

export function ConsoleEditor({ tab, visible }: { tab: ConsoleTab; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const ed = useRef<Monaco.editor.IStandaloneCodeEditor>()
  const { run, cancel, patchTab, live, connections, showResults, set } = useWorkbench()
  const prefs = useWorkbench((s) => s.prefs)
  const model = live[tab.connectionId]?.model
  const conn = connections.find((c) => c.id === tab.connectionId)
  const dialect = connectionDialect(conn, model)
  const history = prefs['query.history'][tab.connectionId] ?? []
  const [histOpen, setHistOpen] = useState(false)

  const exec = (script: boolean) => {
    const e = ed.current; if (!e) return
    const text = e.getValue(), sel = e.getSelection(), m = e.getModel()!
    if (sel && !sel.isEmpty()) return void run(tab.id, splitStatements(m.getValueInRange(sel)).map((s) => s.text))
    if (script) return void run(tab.id, splitStatements(text).map((s) => s.text))
    const st = statementAt(text, m.getOffsetAt(e.getPosition()!))
    if (st) void run(tab.id, [st.text])
  }
  const execRef = useRef(exec); execRef.current = exec

  useEffect(() => {
    const monaco = ensureMonaco(); syncMonacoTheme()
    const e = monaco.editor.create(host.current!, { value: tab.sql, language: 'sql', theme: 'stratum', automaticLayout: true, minimap: { enabled: prefs['editor.minimap'] }, fontSize: prefs['editor.fontSize'], wordWrap: prefs['editor.wordWrap'], fontFamily: monoFontStack(prefs['editor.fontFamily']), fontLigatures: true, scrollBeyondLastLine: false, renderLineHighlight: 'line', padding: { top: 10 }, smoothScrolling: true, quickSuggestions: { other: prefs['completion.enabled'], strings: false, comments: false }, bracketPairColorization: { enabled: true }, lineNumbersMinChars: 3 })
    e.getModel()?.updateOptions({ tabSize: prefs['editor.tabSize'] })
    e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => execRef.current(false))
    e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => execRef.current(true))
    e.onDidChangeModelContent(() => patchTab(tab.id, { sql: e.getValue() }))
    e.onDidFocusEditorText(() => setCompletionModel(useWorkbench.getState().live[tab.connectionId]?.model))
    if (location.search.includes('smoke=1')) Object.assign(window, { __editor: e }) // test hook, only with ?smoke=1
    ed.current = e
    const off = themes.subscribe(syncMonacoTheme)
    return () => { off(); e.dispose() }
  }, [])
  useEffect(() => { if (visible) { setCompletionModel(model); ed.current?.layout(); ed.current?.focus() } }, [visible, model])
  useEffect(() => { // Settings dialog: apply editor preferences live.
    const e = ed.current; if (!e) return
    e.updateOptions({ fontSize: prefs['editor.fontSize'], fontFamily: monoFontStack(prefs['editor.fontFamily']), wordWrap: prefs['editor.wordWrap'], minimap: { enabled: prefs['editor.minimap'] }, quickSuggestions: { other: prefs['completion.enabled'], strings: false, comments: false } })
    e.getModel()?.updateOptions({ tabSize: prefs['editor.tabSize'] })
  }, [prefs])
  useEffect(() => window.stratum.onCommand((c) => { if (!visible) return; if (c === 'run.statement') execRef.current(false); if (c === 'run.script') execRef.current(true); if (c === 'run.cancel') void cancel(tab.id) }), [visible])

  return (
    <div className="console">
      <div className="editor-toolbar">
        <button className="run" title="Execute (Ctrl/⌘+Enter)" disabled={tab.running} onClick={() => exec(false)}><Icon id="play" /></button>
        <button title="Execute script (Ctrl/⌘+Shift+Enter)" disabled={tab.running} onClick={() => exec(true)}><Icon id="run-all" /></button>
        <button title="Cancel (Ctrl/⌘+F2)" disabled={!tab.running} onClick={() => void cancel(tab.id)}><Icon id="debug-stop" /></button>
        <div className="menu-host">
          <button title="Query history" disabled={!history.length} onClick={() => setHistOpen((o) => !o)}><Icon id="history" /></button>
          {histOpen && (
            <div className="popmenu popmenu-wide" onMouseLeave={() => setHistOpen(false)}>
              {history.map((h, i) => (
                <button key={i} title={h} onClick={() => { setHistOpen(false); ed.current?.trigger('history', 'type', { text: h }) }}>
                  {h.replace(/\s+/g, ' ').slice(0, 80)}{h.length > 80 ? '…' : ''}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="sep" />
        <span className="ds"><Icon id="database" /> {conn?.name}</span>
        <span className="grow" />
        <button title="Toggle results" onClick={() => set({ showResults: !showResults })}><Icon id={showResults ? 'layout-panel' : 'layout-panel-off'} /></button>
      </div>
      <div className="split">
        <div className="editor-host" ref={host} />
        {showResults && <ResultsPane results={tab.results} active={tab.activeResult} onActive={(i) => patchTab(tab.id, { activeResult: i })} running={tab.running} dialect={dialect} />}
      </div>
    </div>
  )
}
