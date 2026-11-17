import { useEffect, useRef, useState } from 'react'
import { isValidBreakpointLine } from '../../../../core/debug'
import { ensureMonaco, syncMonacoTheme } from '../../monaco'
import { themes } from '../../theme/themeManager'
import { monoFontStack } from '../../theme/fonts'
import { useWorkbench, type DebugTab } from '../../store/workbench'
import { Icon } from '../../ui/Icon'
import type * as Monaco from 'monaco-editor/editor/editor.api'

const valueText = (value: unknown): string => {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Debug tab: read-only routine source with gutter breakpoints, call stack, variables and the
 * target result. The backend owns the session and returns a full snapshot after every command;
 * this view only paints that snapshot and forwards commands.
 */
export function DebugView({ tab, visible }: { tab: DebugTab; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const ed = useRef<Monaco.editor.IStandaloneCodeEditor | undefined>(undefined)
  const decorations = useRef<string[]>([])
  const latest = useRef(tab)
  latest.current = tab
  const prefs = useWorkbench((s) => s.prefs)
  const connection = useWorkbench((s) => s.connections.find((c) => c.id === tab.connectionId))
  const { debugResume, debugStepOver, debugStepInto, debugStop, debugSelectFrame, debugToggleBreakpoint, debugSetVariable } = useWorkbench()
  const [editing, setEditing] = useState<{ name: string; line: number; value: string } | null>(null)

  const paused = tab.status === 'paused'
  const canStep = paused && !tab.busy && !tab.stopping
  const canStop = tab.status !== 'stopped' && !tab.stopping
  const source = tab.snapshot.source
  const breakpoint = tab.snapshot.breakpoint

  const paint = () => {
    const editor = ed.current, model = editor?.getModel()
    if (!editor || !model) return
    const monaco = ensureMonaco()
    const t = latest.current
    const text = t.snapshot.source?.text ?? ''
    if (model.getValue() !== text) model.setValue(text)
    monaco.editor.setModelLanguage(model, 'sql')
    const oid = t.snapshot.source?.oid
    const decos: Monaco.editor.IModelDeltaDecoration[] = []
    for (const bp of t.snapshot.breakpoints) {
      if (bp.oid !== oid || bp.line < 1 || bp.line > model.getLineCount()) continue
      decos.push({
        range: new monaco.Range(bp.line, 1, bp.line, 1),
        options: { glyphMarginClassName: 'debug-bp', glyphMarginHoverMessage: { value: `Breakpoint · line ${bp.line}` } },
      })
    }
    const current = t.snapshot.breakpoint
    if (current && current.oid === oid && current.line >= 1 && current.line <= model.getLineCount()) {
      decos.push({
        range: new monaco.Range(current.line, 1, current.line, 1),
        options: {
          isWholeLine: true,
          className: 'debug-current-line',
          glyphMarginClassName: 'debug-current-arrow',
        },
      })
      if (t.id === useWorkbench.getState().activeTab) editor.revealLineInCenterIfOutsideViewport(current.line)
    }
    decorations.current = editor.deltaDecorations(decorations.current, decos)
  }

  useEffect(() => {
    const monaco = ensureMonaco()
    syncMonacoTheme()
    const editor = monaco.editor.create(host.current!, {
      value: tab.snapshot.source?.text ?? '',
      language: 'sql',
      theme: 'stratum',
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      glyphMargin: true,
      folding: false,
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      renderLineHighlight: 'none',
      fontSize: prefs['editor.fontSize'],
      wordWrap: prefs['editor.wordWrap'],
      fontFamily: monoFontStack(prefs['editor.fontFamily']),
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      padding: { top: 8 },
    })
    editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return
      const line = e.target.position?.lineNumber
      const t = latest.current
      if (!line || !t.snapshot.source || !isValidBreakpointLine(t.snapshot.source.text, line)) return
      void useWorkbench.getState().debugToggleBreakpoint(t.id, line)
    })
    ed.current = editor
    const off = themes.subscribe(syncMonacoTheme)
    paint()
    return () => { off(); editor.dispose() }
  }, [])

  // Repaint when the source, the current line or the registered breakpoints change.
  useEffect(() => {
    paint()
  }, [tab.snapshot.source?.oid, tab.snapshot.source?.text, tab.snapshot.breakpoint?.oid, tab.snapshot.breakpoint?.line, tab.snapshot.breakpoints, visible])

  useEffect(() => {
    ed.current?.updateOptions({
      fontSize: prefs['editor.fontSize'],
      fontFamily: monoFontStack(prefs['editor.fontFamily']),
      wordWrap: prefs['editor.wordWrap'],
    })
  }, [prefs['editor.fontSize'], prefs['editor.fontFamily'], prefs['editor.wordWrap']])

  useEffect(() => {
    if (!visible) return
    ed.current?.layout()
  }, [visible])

  useEffect(() => {
    if (!paused) setEditing(null)
  }, [paused])

  const statusText = tab.stopping
    ? 'Stopping…'
    : tab.busy
      ? 'Running…'
      : tab.status === 'paused'
        ? breakpoint ? `Paused at line ${breakpoint.line}` : 'Paused'
        : tab.status === 'running' ? 'Running…'
          : tab.status === 'finished' ? `Finished${tab.snapshot.result ? ` in ${tab.snapshot.result.durationMs} ms` : ''}`
            : tab.status === 'failed' ? 'The target failed'
              : 'Stopped · changes rolled back'

  return (
    <div className="debug-view">
      <div className="editor-toolbar debug-toolbar">
        <button className="run" title="Continue to the next breakpoint" disabled={!canStep} onClick={() => void debugResume(tab.id)}>
          <Icon id="debug-continue" />Continue
        </button>
        <button title="Step over (next statement)" disabled={!canStep} onClick={() => void debugStepOver(tab.id)}>
          <Icon id="debug-step-over" />Step over
        </button>
        <button title="Step into the called routine" disabled={!canStep} onClick={() => void debugStepInto(tab.id)}>
          <Icon id="debug-step-into" />Step into
        </button>
        <button className="debug-stop" title="Abort the target and roll back its transaction" disabled={!canStop} onClick={() => void debugStop(tab.id)}>
          <Icon id="debug-stop" />{tab.stopping ? 'Stopping…' : 'Stop'}
        </button>
        <span className="sep" />
        <span className={`debug-state ${tab.status}`}>{tab.busy && !tab.stopping ? <Icon id="loading" className="codicon-modifier-spin" /> : null}{statusText}</span>
        {tab.snapshot.error && <span className="format-note error" title={tab.snapshot.error}>{tab.snapshot.error}</span>}
        {tab.error && <span className="format-note error" title={tab.error}>{tab.error}</span>}
        <span className="grow" />
        <span className="ds"><Icon id="database" /> <span className="ds-name">{connection?.name}</span></span>
      </div>

      <div className="debug-main">
        <div className="debug-source-card">
          <div className="debug-source-head">
            <Icon id="debug-alt" />
            <strong>{source ? `${source.schema}.${source.name}` : tab.routine.schema + '.' + tab.routine.name}</strong>
            <span className="debug-source-kind">{tab.routine.kind === 'procedure' ? 'procedure' : 'function'}</span>
            <span className="grow" />
            <span className="hint"><Icon id="info" />Click the gutter to toggle a breakpoint</span>
          </div>
          <div className="editor-host debug-editor" ref={host} />
          {!source && tab.status !== 'stopped' && <p className="hint debug-no-source"><Icon id="info" />The server did not return the routine source.</p>}
        </div>

        <div className="debug-panels">
          <section className="debug-panel">
            <header><Icon id="type-hierarchy" />Call stack<span>{tab.snapshot.frames.length}</span></header>
            <div className="debug-list">
              {!tab.snapshot.frames.length && <p className="hint"><Icon id="info" />No stack while the target is not paused.</p>}
              {tab.snapshot.frames.map((frame) => (
                <button
                  key={`${frame.level}-${frame.oid}-${frame.line}`}
                  type="button"
                  className={`debug-frame${frame.level === tab.snapshot.selectedFrame ? ' on' : ''}`}
                  title={frame.args || frame.name}
                  onClick={() => void debugSelectFrame(tab.id, frame.level)}
                >
                  <span className="level">{frame.level}</span>
                  <span className="name">{frame.name || frame.oid}</span>
                  <span className="line">{frame.line}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="debug-panel">
            <header><Icon id="symbol-parameter" />Variables<span>{tab.snapshot.variables.length}</span></header>
            <div className="debug-list debug-vars">
              {!tab.snapshot.variables.length && <p className="hint"><Icon id="info" />No variables reported for this frame.</p>}
              {tab.snapshot.variables.map((v) => (
                <div className="debug-var" key={`${v.name}-${v.line}`}>
                  <div className="debug-var-head">
                    <span className="name" title={v.constant ? 'Constant: the server rejects assignments' : v.name}>{v.name}</span>
                    <span className="type">{v.type}</span>
                  </div>
                  {editing?.name === v.name && editing.line === v.line
                    ? <input
                        autoFocus
                        className="debug-var-input"
                        aria-label={`New value for ${v.name}`}
                        value={editing.value}
                        onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                        onBlur={() => setEditing(null)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') { setEditing(null); return }
                          if (e.key !== 'Enter') return
                          e.preventDefault()
                          const next = editing
                          setEditing(null)
                          if (next.value.trim()) void debugSetVariable(tab.id, next.name, next.line, next.value)
                        }}
                      />
                    : <button
                        type="button"
                        className={`debug-var-value${v.value === null ? ' null' : ''}`}
                        disabled={v.constant || !paused || !!tab.busy}
                        title={v.constant ? 'Constant variable' : 'Click to assign a SQL expression'}
                        onClick={() => setEditing({ name: v.name, line: v.line, value: v.value ?? '' })}
                      >{v.value ?? 'NULL'}</button>}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      {tab.snapshot.result && (
        <div className="debug-result">
          <div className="debug-result-head">
            <Icon id="table" />Result
            <span className="debug-result-meta">{tab.snapshot.result.rows.length} row{tab.snapshot.result.rows.length === 1 ? '' : 's'}{tab.snapshot.result.truncated ? ' (truncated)' : ''} · {tab.snapshot.result.durationMs} ms</span>
            <span className="grow" />
            <code title={tab.snapshot.result.sql}>{tab.snapshot.result.sql}</code>
          </div>
          <div className="debug-result-scroll">
            <table className="debug-result-table">
              <thead><tr>{tab.snapshot.result.columns.map((c, i) => <th key={`${c.name}-${i}`}>{c.name}{c.type && <em>{c.type}</em>}</th>)}</tr></thead>
              <tbody>
                {tab.snapshot.result.rows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((value, ci) => <td key={ci} className={value === null ? 'null' : undefined} title={valueText(value)}>{valueText(value)}</td>)}
                  </tr>
                ))}
                {!tab.snapshot.result.rows.length && <tr><td className="null" colSpan={Math.max(1, tab.snapshot.result.columns.length)}>No rows returned.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
