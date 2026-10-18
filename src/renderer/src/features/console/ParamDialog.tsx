import { useEffect, useState } from 'react'
import { useWorkbench } from '../../store/workbench'
import { Icon } from '../../ui/Icon'

/** DataGrip-style parameter prompt: one input per distinct `:name` / `${name}` / `#name#`. */
export function ParamDialog() {
  const req = useWorkbench((s) => s.paramRequest)
  const respond = useWorkbench((s) => s.respondParams)
  const [values, setValues] = useState<Record<string, string>>({})
  useEffect(() => { if (req) setValues(req.values) }, [req])
  if (!req) return null
  const execute = () => respond(Object.fromEntries(req.params.map((p) => [p.name, values[p.name] ?? ''])))
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && respond(null)}>
      <div className="dialog param-dialog" role="dialog" aria-label="SQL parameters">
        <header><Icon id="symbol-parameter" /> SQL parameters<button onClick={() => respond(null)}><Icon id="close" /></button></header>
        <div className="form">
          <p className="hint"><Icon id="info" /> This statement uses parameters. Enter a value for each one (remembered for next time).</p>
          {req.params.map((p, i) => (
            <label className="field span-2" key={p.name}><span>{p.name} <code>{p.raw}</code></span>
              <input autoFocus={i === 0} value={values[p.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && execute()} />
            </label>
          ))}
        </div>
        <footer>
          <span className="grow" />
          <button onClick={() => respond(null)}>Cancel</button>
          <button className="primary" onClick={execute}>Execute</button>
        </footer>
      </div>
    </div>
  )
}
