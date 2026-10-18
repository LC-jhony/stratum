import { useEffect, useRef, useState } from 'react'
import { isSqlKind } from '../../../shared/kinds'
import { elasticStatementAt, splitElasticStatements } from '../../../shared/elastic'
import { mongoStatementAt, splitMongoStatements } from '../../../shared/mongo'
import { redisStatementAt, splitRedisStatements } from '../../../shared/redis'
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
  const sqlKind = isSqlKind(conn?.kind)
  const redis = conn?.kind === 'redis'
  const elastic = conn?.kind === 'elastic'
  const cassandra = conn?.kind === 'cassandra'
  const history = prefs['query.history'][tab.connectionId] ?? []
  const [histOpen, setHistOpen] = useState(false)

  /** Console language: SQL/CQL for those providers, redis-cli / Dev Tools / mongosh text otherwise. */
  const split = (text: string) => (sqlKind || cassandra ? splitStatements(text) : redis ? splitRedisStatements(text) : elastic ? splitElasticStatements(text) : splitMongoStatements(text)).map((s) => s.text)
  const at = (text: string, offset: number) => (sqlKind || cassandra ? statementAt(text, offset) : redis ? redisStatementAt(text, offset) : elastic ? elasticStatementAt(text, offset) : mongoStatementAt(text, offset))

  const exec = (script: boolean) => {
    const e = ed.current; if (!e) return
    const text = e.getValue(), sel = e.getSelection(), m = e.getModel()!
    if (sel && !sel.isEmpty()) return void run(tab.id, split(m.getValueInRange(sel)))
    if (script) return void run(tab.id, split(text))
    const st = at(text, m.getOffsetAt(e.getPosition()!))
    if (st) void run(tab.id, [st.text])
  }
  const execRef = useRef(exec); execRef.current = exec

  useEffect(() => {
    const monaco = ensureMonaco(); syncMonacoTheme()
    const e = monaco.editor.create(host.current!, { value: tab.sql, language: sqlKind ? 'sql' : 'plaintext', theme: 'stratum', automaticLayout: true, minimap: { enabled: prefs['editor.minimap'] }, fontSize: prefs['editor.fontSize'], wordWrap: prefs['editor.wordWrap'], fontFamily: monoFontStack(prefs['editor.fontFamily']), fontLigatures: true, scrollBeyondLastLine: false, renderLineHighlight: 'line', padding: { top: 10 }, smoothScrolling: true, quickSuggestions: { other: sqlKind && prefs['completion.enabled'], strings: false, comments: false }, bracketPairColorization: { enabled: true }, lineNumbersMinChars: 3 })
    e.getModel()?.updateOptions({ tabSize: prefs['editor.tabSize'] })
    e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => execRef.current(false))
    e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => execRef.current(true))
    e.onDidChangeModelContent(() => patchTab(tab.id, { sql: e.getValue() }))
    e.onDidFocusEditorText(() => setCompletionModel(sqlKind ? useWorkbench.getState().live[tab.connectionId]?.model : undefined))
    if (location.search.includes('smoke=1')) Object.assign(window, { __editor: e }) // test hook, only with ?smoke=1
    ed.current = e
    const off = themes.subscribe(syncMonacoTheme)
    return () => { off(); e.dispose() }
  }, [])
  useEffect(() => { if (visible) { setCompletionModel(sqlKind ? model : undefined); ed.current?.layout(); ed.current?.focus() } }, [visible, model, sqlKind])
  useEffect(() => { // Settings dialog: apply editor preferences live.
    const e = ed.current; if (!e) return
    e.updateOptions({ fontSize: prefs['editor.fontSize'], fontFamily: monoFontStack(prefs['editor.fontFamily']), wordWrap: prefs['editor.wordWrap'], minimap: { enabled: prefs['editor.minimap'] }, quickSuggestions: { other: sqlKind && prefs['completion.enabled'], strings: false, comments: false } })
    e.getModel()?.updateOptions({ tabSize: prefs['editor.tabSize'] })
  }, [prefs, sqlKind])
  useEffect(() => window.stratum.onCommand((c) => { if (!visible) return; if (c === 'run.statement') execRef.current(false); if (c === 'run.script') execRef.current(true); if (c === 'run.cancel') void cancel(tab.id) }), [visible])

  return (
    <div className="console">
      <div className="split">
        <div className="editor-card">
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
            <span className="ds"><Icon id="database" /> <span className="ds-name">{conn?.name}</span></span>
            <span className="grow" />
            <button title="Toggle results" onClick={() => set({ showResults: !showResults })}><Icon id={showResults ? 'layout-panel' : 'layout-panel-off'} /></button>
          </div>
          <div className="editor-host" ref={host} />
        </div>
        {showResults && <ResultsPane tabId={tab.id} results={tab.results} active={tab.activeResult} onActive={(i) => patchTab(tab.id, { activeResult: i })} running={tab.running} dialect={dialect} />}
      </div>
    </div>
  )
}
