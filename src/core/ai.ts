/**
 * AI assistant plumbing shared by main and renderer: provider defaults, the schema context sent
 * with every request, request/response shapes for OpenAI-compatible, Anthropic and Ollama APIs,
 * and SQL extraction from the answer. Pure: no network here.
 */
import type { AiMessage, AiProvider } from '../shared/ai'
import type { DatabaseModel } from '../shared/types'

export interface AiConfig {
  provider: AiProvider
  endpoint: string
  model: string
  /** Plain key in main (already unsealed); never persisted here. */
  apiKey?: string
}

export const AI_PROVIDERS: readonly { id: AiProvider; label: string; endpoint: string; model: string; needsKey: boolean }[] = [
  { id: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needsKey: true },
  { id: 'anthropic', label: 'Anthropic', endpoint: 'https://api.anthropic.com', model: 'claude-3-5-sonnet-latest', needsKey: true },
  { id: 'ollama', label: 'Ollama (local)', endpoint: 'http://localhost:11434', model: 'llama3.1', needsKey: false },
  { id: 'custom', label: 'OpenAI-compatible', endpoint: 'http://localhost:8080/v1/chat/completions', model: 'local-model', needsKey: false },
]

export const providerInfo = (provider: AiProvider) => AI_PROVIDERS.find((p) => p.id === provider) ?? AI_PROVIDERS[0]

/** Coerce the `ai.*` settings; an unknown provider means the assistant is off. */
export function aiConfigFromSettings(settings: Record<string, unknown>, apiKey?: string): AiConfig | undefined {
  const provider = settings['ai.provider']
  if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'ollama' && provider !== 'custom') return undefined
  const info = providerInfo(provider)
  const text = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback)
  return {
    provider,
    endpoint: text(settings['ai.endpoint'], info.endpoint).replace(/\/+$/, ''),
    model: text(settings['ai.model'], info.model),
    ...(apiKey ? { apiKey } : {}),
  }
}

const joinUrl = (endpoint: string, suffix: string): string =>
  endpoint.endsWith(suffix) ? endpoint : `${endpoint.replace(/\/+$/, '')}${suffix}`

/** Complete endpoint for each API; a full URL typed by the user wins. */
export function aiEndpoint(cfg: AiConfig): string {
  if (cfg.provider === 'anthropic') return joinUrl(cfg.endpoint, '/v1/messages')
  if (cfg.provider === 'ollama') return joinUrl(cfg.endpoint, '/api/chat')
  if (cfg.provider === 'custom') return cfg.endpoint
  return joinUrl(cfg.endpoint, '/chat/completions')
}

const SQL_START = /^\s*(select|with|insert|update|delete|create|alter|drop|truncate|explain|pragma)\b/i

/**
 * Compact schema catalogue: only what fits, tables before views, `schema.table(column type, …)`.
 * Explicitly bounded so a 10,000-table database cannot blow up a request.
 */
export function schemaContext(model: DatabaseModel | undefined, maxChars = 12_000): string {
  if (!model?.schemas.length) return ''
  const lines: string[] = [`Dialect: ${model.dialect}${model.version ? ` (${model.version})` : ''}`]
  let tables = 0
  outer: for (const schema of model.schemas) {
    const prefix = schema.name ? `${schema.name}.` : ''
    for (const table of [...schema.tables].sort((a, b) => a.name.localeCompare(b.name))) {
      const cols = table.columns.map((c) => {
        const bits = [c.name, c.dataType]
        if (c.isPrimaryKey) bits.push('PK')
        if (!c.nullable) bits.push('not null')
        return bits.filter(Boolean).join(' ')
      })
      const fks = table.foreignKeys.map((fk) => `${fk.columns.join('+')}->${fk.refSchema ? `${fk.refSchema}.` : ''}${fk.refTable}.${fk.refColumns.join('+')}`)
      const line = `- ${prefix}${table.name}(${cols.join(', ')}${fks.length ? `; FK: ${fks.join(', ')}` : ''})${table.kind === 'view' ? ' [view]' : ''}`
      if (lines.join('\n').length + line.length > maxChars) break outer
      lines.push(line)
      tables++
      if (tables >= 80) break outer
    }
  }
  if (tables < countTables(model)) lines.push(`- … ${countTables(model) - tables} more table(s) omitted`)
  return lines.join('\n')
}

const countTables = (model: DatabaseModel): number => model.schemas.reduce((n, s) => n + s.tables.length, 0)

/** System prompt: schema-grounded, concise, SQL in fences so the UI can offer one-click insertion. */
export function systemPrompt(context: string): string {
  const base = 'You are the SQL assistant inside Stratum, a database IDE. Answer concisely in the same language as the user. Put every SQL statement inside a fenced ```sql block. Never invent tables or columns that are not in the schema; when something is missing, say so. Prefer read-only statements unless the user explicitly asks for a change.'
  return context ? `${base}\n\nCurrent schema:\n${context}` : `${base}\n\nNo schema is connected; give generic SQL and say it may need adapting.`
}

export interface AiRequest {
  url: string
  headers: Record<string, string>
  body: unknown
}

/** Provider-specific HTTP request. Anthropic takes the system prompt outside `messages`. */
export function buildAiRequest(cfg: AiConfig, messages: readonly AiMessage[], context: string): AiRequest {
  const system = systemPrompt(context)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cfg.provider === 'openai' || cfg.provider === 'custom') {
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`
    return {
      url: aiEndpoint(cfg),
      headers,
      body: { model: cfg.model, temperature: 0.2, max_tokens: 2048, messages: [{ role: 'system', content: system }, ...messages] },
    }
  }
  if (cfg.provider === 'anthropic') {
    if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey
    headers['anthropic-version'] = '2023-06-01'
    return {
      url: aiEndpoint(cfg),
      headers,
      body: {
        model: cfg.model, max_tokens: 2048, system,
        messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
      },
    }
  }
  return {
    url: aiEndpoint(cfg),
    headers,
    body: { model: cfg.model, stream: false, options: { temperature: 0.2 }, messages: [{ role: 'system', content: system }, ...messages] },
  }
}

/** Text of a successful response; throws with the provider's own message when the shape is wrong. */
export function parseAiResponse(provider: AiProvider, payload: unknown): string {
  const p = payload as Record<string, unknown> | undefined
  if (!p || typeof p !== 'object') throw new Error('The AI provider returned an empty response.')
  if (typeof p.error === 'object' && p.error) {
    const message = (p.error as { message?: unknown }).message
    if (typeof message === 'string' && message) throw new Error(message)
  }
  let text = ''
  if (provider === 'anthropic') {
    const content = Array.isArray(p.content) ? p.content : []
    text = content.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('\n')
  } else if (provider === 'ollama') {
    const message = p.message as { content?: unknown } | undefined
    if (typeof message?.content === 'string') text = message.content
  } else {
    const choices = Array.isArray(p.choices) ? p.choices : []
    const first = choices[0] as { message?: { content?: unknown }; text?: unknown } | undefined
    if (typeof first?.message?.content === 'string') text = first.message.content
    else if (typeof first?.text === 'string') text = first.text
  }
  text = text.trim()
  if (!text) throw new Error('The AI provider returned no text.')
  return text
}

/** Fenced SQL blocks from an answer; falls back to the whole text when it is a bare statement. */
export function extractSql(text: string): string[] {
  const out: string[] = []
  const fence = /```([a-z0-9_-]*)\s*\n([\s\S]*?)```/gi
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    const lang = m[1].toLowerCase(), body = m[2].trim()
    if (!body) continue
    if (lang === '' || lang === 'sql' || lang.startsWith('postgres') || ['mysql', 'mariadb', 'sqlite', 'plsql', 'tsql'].includes(lang)) {
      if (SQL_START.test(body)) out.push(body)
    }
  }
  if (!out.length) {
    const trimmed = text.trim()
    if (SQL_START.test(trimmed) && !trimmed.includes('```')) out.push(trimmed.replace(/;?\s*$/, ''))
  }
  return [...new Set(out)]
}
