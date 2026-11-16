/** AI assistant contracts shared by main, preload and renderer. */
export type AiProvider = 'openai' | 'anthropic' | 'ollama' | 'custom'
export type AiProviderId = 'none' | AiProvider

export interface AiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** One answer plus the SQL blocks extracted from it. */
export interface AiChatResult {
  text: string
  sql: string[]
  provider: AiProvider
  model: string
}
