/** Locale resolution and message lookup shared by main (native menu) and renderer (React UI). */
import { en, type MessageKey } from './en'
import { es } from './es'

export type { MessageKey } from './en'

export type Locale = 'en' | 'es'
export const LOCALES: readonly Locale[] = ['en', 'es']
/** Native names, never translated: a person looking for their language should recognise it. */
export const LOCALE_LABEL: Record<Locale, string> = { en: 'English', es: 'Español' }

const CATALOGS: Record<Locale, Record<string, string>> = { en, es }
export type MessageVars = Record<string, string | number>

/**
 * Explicit setting wins; `system` (or anything stale) falls back to the OS language. Spanish is the
 * only translated locale for now, every other system language uses English.
 */
export function resolveLocale(setting: unknown, systemLanguage: string): Locale {
  if (setting === 'en' || setting === 'es') return setting
  return systemLanguage.toLowerCase().startsWith('es') ? 'es' : 'en'
}

/** Look up a key, fall back to English, then to the key itself so a missing string is visible but harmless. */
export function translate(locale: Locale, key: string, vars?: MessageVars): string {
  const template = CATALOGS[locale]?.[key] ?? CATALOGS.en[key] ?? key
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match))
}

export type Translator = (key: string, vars?: MessageVars) => string

export function createTranslator(locale: Locale): Translator {
  return (key, vars) => translate(locale, key, vars)
}

/** Compile-time completeness helper: every English key has a Spanish string. */
export const CATALOG_SIZE: Record<Locale, number> = { en: Object.keys(en).length, es: Object.keys(es).length }
export type KnownMessageKey = MessageKey
