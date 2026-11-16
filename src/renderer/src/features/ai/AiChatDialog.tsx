import { useEffect, useRef, useState } from 'react'
import { AI_PROVIDERS } from '../../../../core/ai'
import type { AiMessage } from '../../../../shared/ai'
import { ipc } from '../../ipc/client'
import { useWorkbench } from '../../store/workbench'
import { Icon } from '../../ui/Icon'

const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')

interface Turn extends AiMessage {
  sql?: string[]
  error?: boolean
}

/** Chat panel bound to the active data source; every answer offers its SQL for the console. */
export function AiChatDialog() {
  const { aiOpen, set, openSettings, prefs, tabs, activeTab, patchTab, openConsole, connections, live } = useWorkbench()
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const bottom = useRef<HTMLDivElement>(null)

  const active = tabs.find((t) => t.id === activeTab)
  const connectionId = active?.connectionId ?? connections[0]?.id
  const connection = connections.find((c) => c.id === connectionId)
  const provider = prefs['ai.provider']
  const providerLabel = AI_PROVIDERS.find((p) => p.id === provider)?.label
  const configured = provider !== 'none'

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [turns, busy])
  if (!aiOpen) return null

  const close = () => set({ aiOpen: false })
  const send = async () => {
    const question = input.trim()
    if (!question || busy) return
    const history: AiMessage[] = [...turns.filter((t) => !t.error).map((t) => ({ role: t.role, content: t.content })), { role: 'user', content: question }]
    setTurns((t) => [...t, { role: 'user', content: question }])
    setInput(''); setBusy(true); setError(undefined)
    try {
      const result = await ipc.ai.chat(connectionId, history)
      setTurns((t) => [...t, { role: 'assistant', content: result.text, sql: result.sql }])
    } catch (e) {
      const message = clean(e)
      setTurns((t) => [...t, { role: 'assistant', content: message, error: true }])
      setError(message)
    } finally { setBusy(false) }
  }
  const insert = (sql: string) => {
    if (active?.type === 'console') {
      patchTab(active.id, { sql: active.sql.trim() ? `${active.sql.replace(/\s+$/, '')}\n\n${sql}` : sql, dirty: true })
    } else if (connectionId) {
      openConsole(connectionId, sql)
    }
    close()
  }
  const clear = () => { setTurns([]); setError(undefined) }

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section className="dialog ai-dialog" role="dialog" aria-label="AI assistant">
        <header>
          <Icon id="sparkle" /> AI Assistant
          <span className="hint ai-provider">{configured ? `${providerLabel} · ${prefs['ai.model'] || 'default model'}` : 'not configured'}</span>
          <button type="button" aria-label="Close" onClick={close}><Icon id="close" /></button>
        </header>

        <div className="ai-context">
          <Icon id="database" />
          <span>{connection ? `${connection.name}${live[connection.id]?.status === 'ready' ? '' : ' (not connected)'}` : 'no data source'}</span>
          <span className="grow" />
          <span className="hint">{prefs['ai.sendSchema'] === false ? 'schema not sent' : connectionId ? 'schema context on' : 'no schema context'}</span>
        </div>

        {!configured && (
          <div className="ai-setup">
            <p>Choose a provider, model and API key in Settings to use the assistant.</p>
            <button type="button" className="primary" onClick={() => { close(); openSettings() }}><Icon id="settings-gear" /> Open Settings</button>
          </div>
        )}

        <div className="ai-log" aria-live="polite">
          {!turns.length && configured && (
            <div className="ai-empty">
              <p>Ask about the connected schema, generate a query, or explain a statement.</p>
              <div className="ai-samples">
                <button type="button" onClick={() => setInput('List the tables and their relationships in this database.')}>Explore the schema</button>
                <button type="button" onClick={() => setInput('Write a query that returns the 20 most recent rows.')}>Write a query</button>
                <button type="button" onClick={() => setInput('Explain what the last statement in my console does.')}>Explain SQL</button>
              </div>
            </div>
          )}
          {turns.map((turn, i) => (
            <article className={`ai-turn ${turn.role}${turn.error ? ' error' : ''}`} key={i}>
              <div className="ai-role"><Icon id={turn.role === 'user' ? 'account' : 'sparkle'} /> {turn.role === 'user' ? 'You' : providerLabel ?? 'Assistant'}</div>
              <pre className="ai-text">{turn.content}</pre>
              {!!turn.sql?.length && (
                <div className="ai-sql">
                  {turn.sql.map((sql, j) => (
                    <div className="ai-sql-block" key={j}>
                      <pre>{sql}</pre>
                      <div className="ai-sql-actions">
                        <button type="button" onClick={() => void navigator.clipboard.writeText(sql)}><Icon id="copy" /> Copy</button>
                        <button type="button" className="primary" onClick={() => insert(sql)}><Icon id="terminal" /> Insert into console</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}
          {busy && <div className="ai-turn assistant"><div className="ai-role"><Icon id="loading" className="codicon-modifier-spin" /> {providerLabel}</div><pre className="ai-text">Thinking…</pre></div>}
          <div ref={bottom} />
        </div>

        {error && <p className="hint error ai-error"><Icon id="error" /> {error}</p>}

        <div className="ai-compose">
          <textarea
            value={input}
            placeholder={configured ? 'Ask about your data… (Ctrl/⌘+Enter to send)' : 'Configure a provider first'}
            disabled={!configured || busy}
            rows={3}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void send() } }}
          />
          <div className="ai-compose-actions">
            <button type="button" onClick={clear} disabled={!turns.length || busy}><Icon id="trash" /> Clear</button>
            <span className="grow" />
            <button type="button" className="primary" disabled={!configured || busy || !input.trim()} onClick={() => void send()}>
              <Icon id={busy ? 'loading' : 'play'} className={busy ? 'codicon-modifier-spin' : undefined} /> Send
            </button>
          </div>
        </div>

        <footer>
          <span className="hint">Answers can be wrong: review SQL before running it.</span>
          <span className="grow" />
          <button type="button" onClick={close}>Close</button>
        </footer>
      </section>
    </div>
  )
}
