import { useEffect, useMemo, useRef, useState } from 'react'
import type { DebugProbe, DebugRoutine } from '../../../../shared/types'
import { buildRoutineCall, validateRoutineForDebug } from '../../../../core/debug'
import { ipc } from '../../ipc/client'
import { useWorkbench } from '../../store/workbench'
import { Icon } from '../../ui/Icon'

const clean = (e: unknown) => (e instanceof Error ? e.message : String(e))
  .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')

/** Why a routine cannot be debugged, or undefined when it can. */
function unsupportedReason(routine: DebugRoutine): string | undefined {
  try { validateRoutineForDebug(routine); return undefined }
  catch (e) { return clean(e) }
}

/**
 * Routine picker. Probing and catalog listing run in parallel so a missing `pldbgapi` shows its
 * installation hint immediately while the list still loads.
 */
export function DebugRoutineDialog() {
  const { debugPicker, connections, set, openDebug } = useWorkbench()
  const conn = connections.find((c) => c.id === debugPicker)
  const [probe, setProbe] = useState<DebugProbe | 'loading'>('loading')
  const [routines, setRoutines] = useState<DebugRoutine[] | 'loading'>('loading')
  const [loadError, setLoadError] = useState<string>()
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<number>()
  const [values, setValues] = useState<string[]>([])
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string>()
  /** Incremented whenever the picker opens or closes; a late start must not adopt the new dialog. */
  const openToken = useRef(0)

  useEffect(() => {
    openToken.current++
    if (!debugPicker) return
    let live = true
    setProbe('loading')
    setRoutines('loading')
    setLoadError(undefined)
    setFilter('')
    setSelected(undefined)
    setValues([])
    setStarting(false)
    setStartError(undefined)
    void ipc.debug.probe(debugPicker)
      .then((p) => { if (live) setProbe(p) })
      .catch((e: unknown) => { if (live) setProbe({ available: false, error: clean(e) }) })
    void ipc.debug.routines(debugPicker)
      .then((list) => {
        if (!live) return
        setRoutines(list)
        setSelected(list[0]?.oid)
      })
      .catch((e: unknown) => { if (live) { setRoutines([]); setLoadError(clean(e)) } })
    return () => { live = false }
  }, [debugPicker])

  const list = useMemo(() => (Array.isArray(routines) ? routines : []), [routines])
  const routine = list.find((r) => r.oid === selected)
  const reason = routine ? unsupportedReason(routine) : undefined

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const out: { schema: string; routines: DebugRoutine[] }[] = []
    for (const r of list) {
      if (q && !`${r.schema}.${r.name} ${r.signature} ${r.returnType}`.toLowerCase().includes(q)) continue
      const last = out[out.length - 1]
      if (last?.schema === r.schema) last.routines.push(r)
      else out.push({ schema: r.schema, routines: [r] })
    }
    // `list` is ordered by schema, but the filter can leave the array in any order only if the
    // backend changes; grouping by the last schema keeps the catalog order intact.
    return out
  }, [list, filter])

  const check = useMemo(() => {
    if (!routine) return { error: undefined as string | undefined, call: undefined as string | undefined }
    try {
      return { error: undefined, call: buildRoutineCall(routine, values) }
    } catch (e) {
      return { error: clean(e), call: undefined }
    }
  }, [routine, values])

  if (!debugPicker) return null
  const close = () => { if (!starting) set({ debugPicker: undefined }) }
  const choose = (oid: number) => {
    setSelected(oid)
    setValues([])
    setStartError(undefined)
  }
  const setValue = (index: number, value: string) => {
    setValues((old) => {
      const next = [...old]
      while (next.length <= index) next.push('')
      next[index] = value
      return next
    })
  }
  const start = async () => {
    if (!routine || starting) return
    const token = openToken.current
    setStarting(true)
    setStartError(undefined)
    try {
      const snapshot = await ipc.debug.start(debugPicker, routine.oid, values)
      // Escape (or a reopened picker) discards this attempt; never leak a paused target.
      if (openToken.current !== token) { void ipc.debug.close(snapshot.id).catch(() => undefined); return }
      openDebug(debugPicker, snapshot)
    } catch (e) {
      if (openToken.current === token) setStartError(clean(e))
    } finally {
      if (openToken.current === token) setStarting(false)
    }
  }

  const canStart = !!routine && !reason && !check.error && probe !== 'loading' && probe.available && !starting

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section className="dialog debug-dialog" role="dialog" aria-label="Debug stored routine">
        <header>
          <Icon id="debug-alt" /> Debug routine
          {conn && <span className="debug-dialog-conn">{conn.name}</span>}
          <button type="button" aria-label="Close" disabled={starting} onClick={close}><Icon id="close" /></button>
        </header>

        {probe === 'loading'
          ? <p className="debug-probe"><Icon id="loading" className="codicon-modifier-spin" />Checking the PostgreSQL debugger…</p>
          : !probe.available
            ? <div className="debug-probe bad">
                <Icon id="triangle-alert" />
                <div>
                  <strong>The debugger extension is not ready on this server.</strong>
                  {probe.error && <p>{probe.error}</p>}
                  {probe.hint && <p>{probe.hint}</p>}
                </div>
              </div>
            : <p className="debug-probe ok">
                <Icon id="pass-filled" />pldbgapi ready
                {probe.proxyApiVersion ? ` · proxy API ${probe.proxyApiVersion}` : ''}
                {probe.serverVersion ? <span className="debug-probe-version"> · {probe.serverVersion}</span> : null}
              </p>}

        <div className="debug-picker">
          <aside className="debug-routine-list">
            <div className="filter"><Icon id="search" /><input autoFocus placeholder="Search routines by name, schema or signature" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
            <div className="debug-routines">
              {routines === 'loading' && <p className="hint"><Icon id="loading" className="codicon-modifier-spin" />Loading PL/pgSQL routines…</p>}
              {loadError && <p className="hint error"><Icon id="triangle-alert" />{loadError}</p>}
              {routines !== 'loading' && !list.length && !loadError && <p className="hint"><Icon id="info" />No PL/pgSQL functions or procedures in this database.</p>}
              {groups.map((group) => (
                <div key={group.schema} className="debug-schema-group">
                  <div className="debug-schema">{group.schema}<span>{group.routines.length}</span></div>
                  {group.routines.map((r) => {
                    const bad = unsupportedReason(r)
                    return (
                      <button
                        key={r.oid}
                        type="button"
                        title={bad ?? `${r.kind} ${r.schema}.${r.name}${r.signature}`}
                        className={`debug-routine${selected === r.oid ? ' on' : ''}${bad ? ' unsupported' : ''}`}
                        onClick={() => choose(r.oid)}
                      >
                        <Icon id={r.kind === 'procedure' ? 'debug-alt' : 'symbol-field'} />
                        <span className="name">{r.name}</span>
                        <span className="sig">{r.signature || '()'}</span>
                        {bad && <span className="badge-kind">unsupported</span>}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </aside>

          <div className="debug-routine-detail">
            {!routine && <p className="hint"><Icon id="info" />Pick a routine to see its parameters.</p>}
            {routine && <>
              <div className="debug-routine-title">
                <Icon id="debug-alt" />
                <div>
                  <h3>{routine.schema}.{routine.name}</h3>
                  <p>{routine.kind === 'procedure' ? 'Procedure' : 'Function'} · {routine.signature || '()'}{routine.kind === 'function' ? ` → ${routine.returnType}` : ''}</p>
                </div>
              </div>

              {reason
                ? <p className="debug-problem"><Icon id="triangle-alert" />{reason}</p>
                : <>
                    <div className="debug-args">
                      {routine.arguments.map((arg, i) => (
                        <label className="field" key={`${arg.name}-${i}`}>
                          <span>{arg.name} <em>{arg.type}</em>{arg.optional && <span className="debug-optional">optional</span>}</span>
                          <input
                            autoFocus={i === 0}
                            value={values[i] ?? ''}
                            placeholder={arg.optional ? 'DEFAULT (leave empty)' : 'SQL expression, e.g. 42 or \'text\''}
                            onChange={(e) => setValue(i, e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && canStart) void start() }}
                          />
                        </label>
                      ))}
                      {!routine.arguments.length && <p className="hint"><Icon id="info" />This routine takes no parameters.</p>}
                    </div>
                    <p className="debug-arg-hint"><Icon id="info" />Each value is a SQL expression; it is wrapped in parentheses and cast to the parameter type. Optional parameters can be omitted only at the end.</p>
                    {check.error
                      ? <p className="debug-problem"><Icon id="triangle-alert" />{check.error}</p>
                      : check.call && <div className="debug-call"><span>Target call</span><code>{check.call}</code></div>}
                  </>}
            </>}
          </div>
        </div>

        <footer>
          {startError && <span className="debug-start-error" title={startError}>{startError}</span>}
          {starting && <span className="hint"><Icon id="loading" className="codicon-modifier-spin" />Waiting for the entry breakpoint…</span>}
          {!startError && !starting && <span className="hint"><Icon id="info" />The routine runs in a transaction; Stop rolls it back.</span>}
          <span className="grow" />
          <button type="button" disabled={starting} onClick={close}>Cancel</button>
          <button type="button" className="primary" disabled={!canStart} onClick={() => void start()}>
            <Icon id="debug-alt" />{starting ? 'Starting…' : 'Start debugging'}
          </button>
        </footer>
      </section>
    </div>
  )
}
