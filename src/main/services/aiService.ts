import { AI_PROVIDERS, aiConfigFromSettings, buildAiRequest, extractSql, parseAiResponse, schemaContext, type AiConfig } from '../../core/ai'
import type { AiChatResult, AiMessage } from '../../shared/ai'
import type { ConnectionManager } from './connectionManager'
import type { SettingsService } from './settingsService'

const MAX_MESSAGES = 20
const MAX_MESSAGE_CHARS = 20_000
const TIMEOUT_MS = 90_000

/**
 * AI chat client. The renderer never sees the API key: it lives sealed in settings.json and is
 * unsealed only here. Each question includes a bounded schema catalogue from the introspected
 * model of the active data source (unless `ai.sendSchema` is off).
 */
export class AiService {
  constructor(private settings: SettingsService, private sessions: ConnectionManager) {}

  /** Provider configuration with the plain key, or a message the chat panel can show. */
  async config(): Promise<AiConfig> {
    const all = await this.settings.get()
    const cfg = aiConfigFromSettings(all, await this.settings.aiKey())
    if (!cfg) throw new Error('Choose an AI provider in Settings first.')
    const info = AI_PROVIDERS.find((p) => p.id === cfg.provider)
    if (info?.needsKey && !cfg.apiKey) throw new Error(`${info.label} needs an API key. Add it in Settings.`)
    return cfg
  }

  async chat(connectionId: string | undefined, messages: readonly AiMessage[]): Promise<AiChatResult> {
    const cfg = await this.config()
    const sendSchema = (await this.settings.get())['ai.sendSchema'] !== false
    let context = ''
    if (sendSchema && connectionId) {
      try {
        // require() keeps this read-only: the chat never opens a connection behind the user's back.
        const model = await this.sessions.require(connectionId).introspect()
        context = schemaContext(model)
      } catch {
        // No live session: answer without schema instead of failing the chat.
      }
    }
    const history = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-MAX_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }))
    if (!history.some((m) => m.role === 'user')) throw new Error('Write a question first.')
    const request = buildAiRequest(cfg, history, context)
    let response: Response
    try {
      response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (e) {
      const reason = e instanceof DOMException && e.name === 'TimeoutError' ? 'the request timed out' : e instanceof Error ? e.message : String(e)
      throw new Error(`Cannot reach ${request.url}: ${reason}`)
    }
    const raw = await response.text()
    let payload: unknown
    try { payload = JSON.parse(raw) } catch {
      throw new Error(`${cfg.provider} returned ${response.status}: ${raw.slice(0, 300) || 'empty body'}`)
    }
    if (!response.ok) {
      try { parseAiResponse(cfg.provider, payload) } catch (e) {
        throw new Error(e instanceof Error ? e.message : `The provider returned HTTP ${response.status}.`)
      }
      throw new Error(`The provider returned HTTP ${response.status}.`)
    }
    const text = parseAiResponse(cfg.provider, payload)
    return { text, sql: extractSql(text), provider: cfg.provider, model: cfg.model }
  }
}
