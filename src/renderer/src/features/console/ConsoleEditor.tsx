import { useEffect, useRef, useState } from 'react'
import { ipc } from '../../ipc/client'
import { isSqlKind } from '../../../../core/kinds'
import { elasticStatementAt, splitElasticStatements } from '../../../../core/elastic'
import { mongoStatementAt, splitMongoStatements } from '../../../../core/mongo'
import { redisStatementAt, splitRedisStatements } from '../../../../core/redis'
import { statementAt, splitStatements } from '../../../../core/sql'
import { connectionDialect } from '../../../../core/dialects'
import { ensureMonaco, setCompletionModel, syncMonacoTheme } from '../../monaco'
import { themes } from '../../theme/themeManager'
import { monoFontStack } from '../../theme/fonts'
import { useWorkbench, type ConsoleTab } from '../../store/workbench'
import { Icon } from '../../ui/Icon'
import { PlanView } from './PlanView'
import { ResultsPane } from './ResultsPane'
import type * as Monaco from 'monaco-editor/editor/editor.api'

const EMPTY_HISTORY: string[] = []

export function ConsoleEditor({ tab, visible }: { tab: ConsoleTab; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const ed = useRef<Monaco.editor.IStandaloneCodeEditor | undefined>(undefined)
  const { run, cancel, patchTab, live, connections, showResults, set, plan, refreshTransaction, beginTransaction, commitTransaction, rollbackTransaction, savepoint, rollbackToSavepoint } = useWorkbench()
  const prefs = useWorkbench((s) => s.prefs)
  const model = live[tab.connectionId]?.model
  const conn = connections.find((c) => c.id === tab.connectionId)
  const tx = useWorkbench((s) => s.transactions[tab.connectionId])
  const dialect = connectionDialect(conn, model)
  const sqlKind = isSqlKind(conn?.kind)
  const redis = conn?.kind === 'redis'
  const elastic = conn?.kind === 'elastic'
  const cassandra = conn?.kind === 'cassandra'
  // Keep the selector snapshot stable: returning a fresh [] from the selector makes
  // useSyncExternalStore re-render forever (React error #185) while the connection has no history yet.
  const history = useWorkbench((s) => s.history[tab.connectionId]) ?? EMPTY_HISTORY
  const [histOpen, setHistOpen] = useState(false)
  const [spEdit, setSpEdit] = useState(false)
  const [spName, setSpName] = useState('')
  const [formatNote, setFormatNote] = useState<{ text: string; error: boolean } | null>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const createSavepoint = async () => {
    const name = spName.trim() || `sp${(tx?.savepoints?.length ?? 0) + 1}`
    await savepoint(tab.connectionId, name)
    setSpEdit(false)
    setSpName('')
  }
  const rollbackSp = async (name: string) => {
    if (!window.confirm(`Roll back to savepoint ${name}? Changes made after it will be discarded.`)) return
    await rollbackToSavepoint(tab.connectionId, name)
  }

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

  /** Statement under the cursor, or the selection when there is one (Explain/Save). */
  const currentSql = (): string | undefined => {
    const e = ed.current, m = e?.getModel()
    if (!e || !m) return undefined
    const sel = e.getSelection()
    if (sel && !sel.isEmpty()) return m.getValueInRange(sel)
    return at(e.getValue(), m.getOffsetAt(e.getPosition()!))?.text
  }

  const explain = () => {
    const sql = currentSql()
    if (!sql?.trim()) { note('Put the cursor on a statement first.', true); return }
    void plan(tab.id, sql)
  }

  const saveQuery = async () => {
    const e = ed.current, m = e?.getModel()
    if (!e || !m) return
    const sel = e.getSelection()
    const sql = sel && !sel.isEmpty() ? m.getValueInRange(sel) : e.getValue()
    if (!sql.trim()) { note('Nothing to save.', true); return }
    const name = window.prompt('Name for the saved query', sql.replace(/\s+/g, ' ').slice(0, 48))
    if (!name?.trim()) return
    try {
      await ipc.library.save({ id: crypto.randomUUID(), name: name.trim(), sql, connectionId: tab.connectionId, createdAt: Date.now(), updatedAt: Date.now() })
      note('Saved to the query library')
    } catch (error) {
      note(error instanceof Error ? error.message : String(error), true)
    }
  }

  const explainRef = useRef(explain); explainRef.current = explain
  const saveRef = useRef(saveQuery); saveRef.current = saveQuery

  /** Transient toolbar feedback for actions that can fail (formatting) without opening a dialog. */
  const note = (text: string, error = false) => {
    if (noteTimer.current) clearTimeout(noteTimer.current)
    setFormatNote({ text, error })
    noteTimer.current = setTimeout(() => setFormatNote(null), error ? 8000 : 3000)
  }

  /** Format the selection, or the whole buffer when nothing is selected. Never runs on non-SQL consoles. */
  const format = async () => {
    const e = ed.current, m = e?.getModel()
    if (!e || !m) return
    if (!sqlKind) { note('Format SQL is only available for SQL consoles.', true); return }
    const sel = e.getSelection()
    const range = sel && !sel.isEmpty() ? sel : m.getFullModelRange()
    const text = m.getValueInRange(range)
    if (!text.trim()) return
    try {
      // Loaded on first use: the formatter is a sizable dependency and most sessions never format.
      const { formatSql } = await import('../../../../core/sqlFormat')
      const out = formatSql(text, dialect, { keywordCase: prefs['completion.keywordCase'], tabWidth: prefs['editor.tabSize'] })
      if (out === text) { note('Already formatted'); return }
      e.pushUndoStop()
      e.executeEdits('sql.format', [{ range, text: out, forceMoveMarkers: true }])
      e.pushUndoStop()
      note(sel && !sel.isEmpty() ? 'Selection formatted' : 'Formatted')
    } catch (error) {
      note(error instanceof Error ? error.message : String(error), true)
    }
  }
  const formatRef = useRef(format); formatRef.current = format

  useEffect(() => {
    const monaco = ensureMonaco(); syncMonacoTheme()
    const e = monaco.editor.create(host.current!, { value: tab.sql, language: sqlKind ? 'sql' : 'plaintext', theme: 'stratum', automaticLayout: true, minimap: { enabled: prefs['editor.minimap'] }, fontSize: prefs['editor.fontSize'], wordWrap: prefs['editor.wordWrap'], fontFamily: monoFontStack(prefs['editor.fontFamily']), fontLigatures: true, scrollBeyondLastLine: false, renderLineHighlight: 'line', padding: { top: 10 }, smoothScrolling: true, quickSuggestions: { other: sqlKind && prefs['completion.enabled'], strings: false, comments: false }, bracketPairColorization: { enabled: true }, lineNumbersMinChars: 3 })
    e.getModel()?.updateOptions({ tabSize: prefs['editor.tabSize'] })
    e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => execRef.current(false))
    e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => execRef.current(true))
    e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () => formatRef.current())
    e.onDidChangeModelContent((ev) => patchTab(tab.id, { sql: e.getValue(), dirty: !ev.isFlush }))
    e.onDidFocusEditorText(() => setCompletionModel(sqlKind ? useWorkbench.getState().live[tab.connectionId]?.model : undefined))
    if (location.search.includes('smoke=1')) Object.assign(window, { __editor: e }) // test hook, only with ?smoke=1
    ed.current = e
    const off = themes.subscribe(syncMonacoTheme)
    return () => { off(); e.dispose() }
  }, [])
  useEffect(() => { if (visible) { setCompletionModel(sqlKind ? model : undefined); ed.current?.layout(); ed.current?.focus() } }, [visible, model, sqlKind])
  useEffect(() => { if (visible && sqlKind) void refreshTransaction(tab.connectionId) }, [visible, sqlKind, tab.connectionId])
  useEffect(() => { // Settings dialog: apply editor preferences live.
    const e = ed.current; if (!e) return
    e.updateOptions({ fontSize: prefs['editor.fontSize'], fontFamily: monoFontStack(prefs['editor.fontFamily']), wordWrap: prefs['editor.wordWrap'], minimap: { enabled: prefs['editor.minimap'] }, quickSuggestions: { other: sqlKind && prefs['completion.enabled'], strings: false, comments: false } })
    e.getModel()?.updateOptions({ tabSize: prefs['editor.tabSize'] })
  }, [prefs, sqlKind])
  useEffect(() => ipc.onCommand((c) => { if (!visible) return; if (c === 'run.statement') execRef.current(false); if (c === 'run.script') execRef.current(true); if (c === 'run.cancel') void cancel(tab.id) }), [visible])
  useEffect(() => {
    const onFormat = () => { if (visible) void formatRef.current() }
    const onExplain = () => { if (visible) explainRef.current() }
    const onSave = () => { if (visible) void saveRef.current() }
    addEventListener('stratum:format', onFormat)
    addEventListener('stratum:explain', onExplain)
    addEventListener('stratum:saveQuery', onSave)
    return () => {
      removeEventListener('stratum:format', onFormat)
      removeEventListener('stratum:explain', onExplain)
      removeEventListener('stratum:saveQuery', onSave)
      if (noteTimer.current) clearTimeout(noteTimer.current)
    }
  }, [visible])

  return (
    <div className="console">
      <div className="split">
        <div className="editor-card">
          <div className="editor-toolbar">
            <button className="run" title="Execute (Ctrl/⌘+Enter)" disabled={tab.running} onClick={() => exec(false)}><Icon id="play" /></button>
            <button title="Execute script (Ctrl/⌘+Shift+Enter)" disabled={tab.running} onClick={() => exec(true)}><Icon id="run-all" /></button>
            <button title="Format SQL (Ctrl/⌘+Shift+F)" disabled={!sqlKind} onClick={format}><Icon id="list-ordered" /></button>
            <button title="Explain execution plan" disabled={!sqlKind || tab.planning} onClick={explain}><Icon id="type-hierarchy" /></button>
            {conn?.kind === 'postgres' && <button title="Debug a stored routine…" onClick={() => set({ debugPicker: tab.connectionId })}><Icon id="debug-alt" /></button>}
            <button title="Save to query library" onClick={() => void saveQuery()}><Icon id="file-down" /></button>
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
            {formatNote && <span className={`format-note${formatNote.error ? ' error' : ''}`} role="status" title={formatNote.text}>{formatNote.text}</span>}
            <span className="grow" />
            <button title="Toggle results" onClick={() => set({ showResults: !showResults })}><Icon id={showResults ? 'layout-panel' : 'layout-panel-off'} /></button>
          </div>
          {sqlKind && (
            <div className={`tx-bar${tx?.open ? ' open' : ''}`}>
              <span className={`tx-dot${tx?.open ? ' on' : ''}`} aria-hidden="true" />
              <span className="tx-label">
                {tab.planning ? 'Explaining…' : tx?.open ? 'Transaction open' : tx?.autoCommit === false ? 'Auto-commit off' : 'Auto-commit'}
              </span>
              {tx?.open && tx.since && <span className="tx-since">since {new Date(tx.since).toLocaleTimeString()}</span>}
              {tx?.failed && <span className="tx-failed">Rollback required</span>}
              <span className="grow" />
              <button type="button" disabled={!!tx?.open} onClick={() => void beginTransaction(tab.connectionId)}>Begin</button>
              {tx?.open && (spEdit ? (
                <span className="tx-sp-edit">
                  <input
                    autoFocus
                    value={spName}
                    placeholder={`sp${(tx.savepoints?.length ?? 0) + 1}`}
                    aria-label="Savepoint name"
                    onChange={(e) => setSpName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void createSavepoint()
                      if (e.key === 'Escape') { setSpEdit(false); setSpName('') }
                    }}
                  />
                  <button type="button" onClick={() => void createSavepoint()}>Save</button>
                </span>
              ) : (
                <button type="button" title="Create a savepoint" onClick={() => { setSpName(`sp${(tx.savepoints?.length ?? 0) + 1}`); setSpEdit(true) }}>Savepoint…</button>
              ))}
              {tx?.open && tx.savepoints?.map((name) => (
                <button key={name} type="button" className="tx-sp" title={`Roll back to savepoint ${name}`} onClick={() => void rollbackSp(name)}>{name}</button>
              ))}
              <button type="button" disabled={!tx?.open} onClick={() => void commitTransaction(tab.connectionId)}>Commit</button>
              <button type="button" disabled={!tx?.open} onClick={() => void rollbackTransaction(tab.connectionId)}>Rollback</button>
            </div>
          )}
          <div className="editor-host" ref={host} />
        </div>
        {tab.plan && <PlanView plan={tab.plan} onClose={() => patchTab(tab.id, { plan: undefined })} />}
        {showResults && <ResultsPane tabId={tab.id} connectionId={tab.connectionId} results={tab.results} active={tab.activeResult} onActive={(i) => patchTab(tab.id, { activeResult: i })} running={tab.running} dialect={dialect} />}
      </div>
    </div>
  )
}
