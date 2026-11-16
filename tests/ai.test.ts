import { describe, expect, it } from 'vitest'
import { aiConfigFromSettings, aiEndpoint, AI_PROVIDERS, buildAiRequest, extractSql, parseAiResponse, schemaContext, systemPrompt } from '../src/core/ai'

const cfg = (patch: Record<string, unknown> = {}) => aiConfigFromSettings({ 'ai.provider': 'openai', 'ai.endpoint': '', 'ai.model': '', ...patch })!

const model = {
  dialect: 'postgres' as const,
  typeof: undefined,
  schemas: [{
    name: 'public',
    tables: [
      {
        name: 'orders', kind: 'table' as const,
        columns: [
          { name: 'id', dataType: 'integer', nullable: false, isPrimaryKey: true },
          { name: 'customer_id', dataType: 'integer', nullable: true },
        ],
        foreignKeys: [{ name: 'fk', columns: ['customer_id'], refSchema: 'public', refTable: 'customers', refColumns: ['id'] }],
        indexes: [],
      },
      { name: 'v_orders', kind: 'view' as const, columns: [{ name: 'total', dataType: 'numeric', nullable: true }], foreignKeys: [], indexes: [] },
    ],
  }],
} as never

describe('settings to config', () => {
  it('falls back to the provider defaults and strips trailing slashes', () => {
    expect(cfg({ 'ai.endpoint': 'https://proxy.example/v1/' })).toMatchObject({
      provider: 'openai', endpoint: 'https://proxy.example/v1', model: 'gpt-4o-mini',
    })
  })

  it('is undefined when the assistant is off or the provider is unknown', () => {
    expect(aiConfigFromSettings({ 'ai.provider': 'none' })).toBeUndefined()
    expect(aiConfigFromSettings({ 'ai.provider': 'nope' })).toBeUndefined()
  })

  it('builds the complete endpoint for each provider', () => {
    expect(aiEndpoint(cfg())).toBe('https://api.openai.com/v1/chat/completions')
    expect(aiEndpoint(cfg({ 'ai.provider': 'anthropic' }))).toBe('https://api.anthropic.com/v1/messages')
    expect(aiEndpoint(cfg({ 'ai.provider': 'ollama' }))).toBe('http://localhost:11434/api/chat')
    expect(aiEndpoint(cfg({ 'ai.provider': 'custom', 'ai.endpoint': 'http://x/v1/chat/completions' }))).toBe('http://x/v1/chat/completions')
  })

  it('does not append twice when the endpoint is already complete', () => {
    expect(aiEndpoint(cfg({ 'ai.endpoint': 'https://api.openai.com/v1/chat/completions' }))).toBe('https://api.openai.com/v1/chat/completions')
    expect(aiEndpoint(cfg({ 'ai.provider': 'anthropic', 'ai.endpoint': 'https://api.anthropic.com/v1/messages' }))).toBe('https://api.anthropic.com/v1/messages')
  })
})

describe('schemaContext', () => {
  it('lists tables, columns, keys and foreign keys', () => {
    const text = schemaContext(model)
    expect(text).toContain('Dialect: postgres')
    expect(text).toContain('public.orders(id integer PK not null, customer_id integer; FK: customer_id->public.customers.id)')
    expect(text).toContain('public.v_orders(total numeric) [view]')
  })

  it('truncates to the character budget', () => {
    const text = schemaContext(model, 80)
    expect(text.length).toBeLessThanOrEqual(100)
    expect(text).toContain('more table(s) omitted')
  })

  it('is empty without a model', () => {
    expect(schemaContext(undefined)).toBe('')
    expect(systemPrompt('')).toContain('No schema is connected')
  })
})

describe('buildAiRequest', () => {
  const messages = [{ role: 'user' as const, content: 'list orders' }]

  it('sends an OpenAI-compatible chat body with the key', () => {
    const req = buildAiRequest({ ...cfg(), apiKey: 'sk-test' }, messages, 'schema')
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(req.headers.authorization).toBe('Bearer sk-test')
    expect(req.body).toMatchObject({ model: 'gpt-4o-mini', messages: [{ role: 'system' }, { role: 'user', content: 'list orders' }] })
  })

  it('moves the system prompt out of Anthropic messages', () => {
    const req = buildAiRequest({ ...cfg({ 'ai.provider': 'anthropic' }), apiKey: 'k' }, messages, 'schema')
    expect(req.headers['x-api-key']).toBe('k')
    expect(req.headers['anthropic-version']).toBe('2023-06-01')
    expect((req.body as { system: string }).system).toContain('schema')
    expect((req.body as { messages: { role: string }[] }).messages.map((m) => m.role)).toEqual(['user'])
  })

  it('uses the Ollama chat endpoint without credentials', () => {
    const req = buildAiRequest(cfg({ 'ai.provider': 'ollama' }), messages, '')
    expect(req.url).toBe('http://localhost:11434/api/chat')
    expect(req.headers.authorization).toBeUndefined()
    expect(req.body).toMatchObject({ stream: false, model: 'llama3.1' })
  })

  it('knows every advertised provider', () => {
    expect(AI_PROVIDERS.map((p) => p.id)).toEqual(['openai', 'anthropic', 'ollama', 'custom'])
  })
})

describe('parseAiResponse', () => {
  it('reads each provider shape', () => {
    expect(parseAiResponse('openai', { choices: [{ message: { content: 'hello' } }] })).toBe('hello')
    expect(parseAiResponse('custom', { choices: [{ text: 'hi' }] })).toBe('hi')
    expect(parseAiResponse('anthropic', { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
    expect(parseAiResponse('ollama', { message: { content: 'local' } })).toBe('local')
  })

  it('surfaces provider errors and empty answers', () => {
    expect(() => parseAiResponse('openai', { error: { message: 'bad key' } })).toThrow('bad key')
    expect(() => parseAiResponse('openai', { choices: [] })).toThrow('no text')
    expect(() => parseAiResponse('openai', null)).toThrow('empty response')
  })
})

describe('extractSql', () => {
  it('returns fenced SQL blocks only', () => {
    const text = 'Use this:\n```sql\nselect * from orders;\n```\nAnd this:\n```\nupdate orders set id = 1\n```\n```json\n{"a":1}\n```'
    expect(extractSql(text)).toEqual(['select * from orders;', 'update orders set id = 1'])
  })

  it('falls back to a bare statement', () => {
    expect(extractSql('select 1')).toEqual(['select 1'])
    expect(extractSql('I cannot help with that.')).toEqual([])
  })

  it('deduplicates repeated blocks', () => {
    expect(extractSql('```sql\nselect 1\n```\n```sql\nselect 1\n```')).toEqual(['select 1'])
  })
})
