// Only the editor core + SQL: importing 'monaco-editor' wholesale would bundle ~80 languages (≈10 MB).
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/editor/editor.all'
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import type { DatabaseModel } from '../../shared/types'
import type { KeywordCase } from '../../core/settings'
import { completeAt, type CompletionKind, type CompletionTable } from '../../core/sqlComplete'
import { themes } from './theme/themeManager'

;(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new editorWorker() }

/** The active data source's catalog, set by the console that has focus. */
let model: DatabaseModel | undefined
export const setCompletionModel = (m?: DatabaseModel) => { model = m }

export interface CompletionOptions {
  enabled: boolean
  suggestOnSpace: boolean
  autoAlias: boolean
  snippets: boolean
  joinByForeignKey: boolean
  keywordCase: KeywordCase
}
let options: CompletionOptions = { enabled: true, suggestOnSpace: true, autoAlias: false, snippets: true, joinByForeignKey: true, keywordCase: 'upper' }
/** Global completion preferences; the Settings dialog applies them live. */
export function setCompletionPrefs(p: Partial<CompletionOptions>) { options = { ...options, ...p } }

const KINDS: Record<CompletionKind, monaco.languages.CompletionItemKind> = {
  column: monaco.languages.CompletionItemKind.Field,
  table: monaco.languages.CompletionItemKind.Struct,
  view: monaco.languages.CompletionItemKind.Interface,
  schema: monaco.languages.CompletionItemKind.Module,
  function: monaco.languages.CompletionItemKind.Function,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  template: monaco.languages.CompletionItemKind.Snippet,
  join: monaco.languages.CompletionItemKind.Snippet,
}

const catalog = (m?: DatabaseModel): CompletionTable[] => (m?.schemas ?? []).flatMap((s) => s.tables.map((t) => ({
  schema: s.name, name: t.name, kind: t.kind,
  columns: t.columns.map((c) => ({ name: c.name, dataType: c.dataType, isPrimaryKey: c.isPrimaryKey })),
  foreignKeys: t.foreignKeys.map((f) => ({ name: f.name, columns: f.columns, refSchema: f.refSchema, refTable: f.refTable, refColumns: f.refColumns })),
})))

/** Word frequency in the document, cached per version — DataGrip's usage-statistics analogue. */
const usageCache = new WeakMap<monaco.editor.ITextModel, { version: number; usage: Map<string, number> }>()
function wordUsage(doc: monaco.editor.ITextModel): Map<string, number> {
  const hit = usageCache.get(doc)
  if (hit && hit.version === doc.getVersionId()) return hit.usage
  const usage = new Map<string, number>()
  for (const m of doc.getValue().slice(0, 512 * 1024).matchAll(/[A-Za-z_][\w$]*/g)) {
    const w = m[0].toLowerCase()
    usage.set(w, (usage.get(w) ?? 0) + 1)
  }
  usageCache.set(doc, { version: doc.getVersionId(), usage })
  return usage
}

let registered = false
export function ensureMonaco() {
  if (registered) return monaco
  registered = true
  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' ', '@'],
    provideCompletionItems(doc, pos) {
      if (!options.enabled) return { suggestions: [] }
      if (!options.suggestOnSpace && pos.column > 1 && doc.getValueInRange(new monaco.Range(pos.lineNumber, pos.column - 1, pos.lineNumber, pos.column)) === ' ') return { suggestions: [] }
      const offset = doc.getOffsetAt(pos)
      const items = completeAt(doc.getValue(), offset, catalog(model), {
        autoAlias: options.autoAlias, keywordCase: options.keywordCase, snippets: options.snippets,
        joinByForeignKey: options.joinByForeignKey, dialect: model?.dialect ?? 'generic',
        usage: wordUsage(doc),
      })
      return {
        suggestions: items.map((c, i) => ({
          label: c.label,
          kind: KINDS[c.kind],
          detail: c.detail,
          insertText: c.insert,
          insertTextRules: c.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          range: monaco.Range.fromPositions(doc.getPositionAt(c.replaceStart), doc.getPositionAt(c.replaceEnd)),
          // The engine already returns candidates best-first (sqlRank.ts); keep its order.
          sortText: String(i).padStart(4, '0'),
        })),
      }
    },
  })
  return monaco
}

/** Re-register the Monaco theme from the active VS Code theme; call whenever the workbench theme changes. */
export function syncMonacoTheme() {
  const m = ensureMonaco()
  const t = themes.monacoTheme()
  if (!t) return
  m.editor.defineTheme('stratum', t)
  m.editor.setTheme('stratum')
}
