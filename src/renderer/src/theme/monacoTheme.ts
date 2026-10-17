import type { ColorThemeJson } from './colorTheme'
import { resolveColors, themeKind } from './colorTheme'

export interface MonacoThemeData { base: 'vs' | 'vs-dark'; inherit: boolean; rules: { token: string; foreground?: string; background?: string; fontStyle?: string }[]; colors: Record<string, string> }

/** Monaco tokenizes with Monarch (prefix-matched tokens), not TextMate. Map TextMate scopes onto the tokens Monaco's SQL grammar emits. */
const SCOPE_TO_TOKEN: [RegExp, string][] = [
  [/^comment/, 'comment'],
  [/^string/, 'string'],
  [/^constant\.numeric/, 'number'],
  [/^constant\.(language|character|other)/, 'constant'],
  [/^keyword\.operator/, 'operator'],
  [/^(keyword|storage)/, 'keyword'],
  [/^(support\.function|entity\.name\.function|meta\.function)/, 'predefined'],
  [/^(entity\.name\.type|support\.type|support\.class|entity\.name\.class)/, 'type'],
  [/^variable\.parameter/, 'variable'],
  [/^punctuation/, 'delimiter'],
  [/^invalid/, 'invalid'],
]
export const scopeToToken = (scope: string): string | undefined => SCOPE_TO_TOKEN.find(([re]) => re.test(scope.trim()))?.[1]

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const strip = (c?: string) => (c && HEX.test(c) ? c.replace('#', '') : undefined)

export function toMonacoTheme(theme: ColorThemeJson): MonacoThemeData {
  const rules: MonacoThemeData['rules'] = []
  const depth = new Map<string, number>() // per Monaco token, the broadest (fewest dots) TextMate scope seen so far
  for (const r of theme.tokenColors ?? []) {
    const scopes = (Array.isArray(r.scope) ? r.scope : (r.scope ?? '').split(',')).map((x) => x.trim()).filter(Boolean)
    if (!scopes.length) { if (r.settings.foreground) rules.push({ token: '', foreground: strip(r.settings.foreground) }); continue } // theme-wide default
    for (const sc of scopes) {
      const token = scopeToToken(sc)
      if (!token) continue
      const d = sc.split('.').length
      if ((depth.get(token) ?? Infinity) <= d) continue
      depth.set(token, d)
      const rule = { token, foreground: strip(r.settings.foreground), background: strip(r.settings.background), fontStyle: r.settings.fontStyle }
      const i = rules.findIndex((x) => x.token === token)
      if (i >= 0) rules[i] = rule; else rules.push(rule)
    }
  }
  const colors = Object.fromEntries(Object.entries(resolveColors(theme)).filter(([, v]) => HEX.test(v)))
  return { base: themeKind(theme) === 'light' ? 'vs' : 'vs-dark', inherit: true, rules, colors }
}
