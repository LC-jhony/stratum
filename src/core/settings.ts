/** User-editable application settings stored in <userData>/settings.json and shared by main + renderer. */

export type KeywordCase = 'upper' | 'lower' | 'preserve'
/** Color mode: pin dark/light or follow the OS (System). */
export type AppearanceMode = 'dark' | 'light' | 'system'
/** Side of the workbench activity bar + side bar (VS Code's "Side Bar: Position"). */
export type SideBarPosition = 'left' | 'right'

export interface StratumSettings {
  /** Settings reflects the active color mode; dark/light pin a theme kind, system follows the OS. */
  'appearance.mode': AppearanceMode
  /** Workbench activity bar and side bar side. */
  'workbench.sideBar.position': SideBarPosition
  /** Monospace family for the editor, grids and code blocks; empty keeps the built-in chain. */
  'editor.fontFamily': string
  'editor.fontSize': number
  'editor.tabSize': number
  'editor.wordWrap': 'on' | 'off'
  'editor.minimap': boolean
  'completion.enabled': boolean
  'completion.suggestOnSpace': boolean
  /** DataGrip-style: "Automatically add aliases when completing table names". */
  'completion.autoAlias': boolean
  'completion.snippets': boolean
  'completion.joinByForeignKey': boolean
  'completion.keywordCase': KeywordCase
  /** Rows fetched per page by consoles and the data editor. */
  'query.pageSize': number
  /** Ask before running UPDATE / DELETE without WHERE. */
  'query.confirmDestructive': boolean
  /** Prompt for `:name` / `:'name'` / `${name}` / `$(name)` / `#name#` before running a statement. */
  'query.parameters.enabled': boolean
  /** Last value entered per parameter name (DataGrip remembers them too). */
  'query.parameters.values': Record<string, string>
  'jdbc.jarPath': string
  'jdbc.javaHome': string
  /** Advanced free-form keys pass through to the JSON store untouched. */
  [key: string]: unknown
}

export const DEFAULT_SETTINGS: StratumSettings = {
  'appearance.mode': 'system',
  'workbench.sideBar.position': 'left',
  'editor.fontFamily': '',
  'editor.fontSize': 13,
  'editor.tabSize': 2,
  'editor.wordWrap': 'off',
  'editor.minimap': false,
  'completion.enabled': true,
  'completion.suggestOnSpace': true,
  'completion.autoAlias': false,
  'completion.snippets': true,
  'completion.joinByForeignKey': true,
  'completion.keywordCase': 'upper',
  'query.pageSize': 100,
  'query.confirmDestructive': true,
  'query.parameters.enabled': true,
  'query.parameters.values': {},
  'jdbc.jarPath': '',
  'jdbc.javaHome': '',
}

const num = (v: unknown, d: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d)
const obj = <T extends object>(v: unknown, d: T): T => (v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : d)

/** Merge raw persisted JSON over the defaults, coercing known keys to safe values; unknown keys pass through. */
export function mergeSettings(raw?: Record<string, unknown>): StratumSettings {
  const r = raw ?? {}
  return {
    ...DEFAULT_SETTINGS,
    ...r,
    'appearance.mode': r['appearance.mode'] === 'dark' || r['appearance.mode'] === 'light' ? r['appearance.mode'] : 'system',
    'workbench.sideBar.position': r['workbench.sideBar.position'] === 'right' ? 'right' : 'left',
    'editor.fontFamily': str(r['editor.fontFamily'], '').slice(0, 200),
    'editor.fontSize': num(r['editor.fontSize'], DEFAULT_SETTINGS['editor.fontSize'], 8, 32),
    'editor.tabSize': num(r['editor.tabSize'], DEFAULT_SETTINGS['editor.tabSize'], 1, 8),
    'editor.wordWrap': r['editor.wordWrap'] === 'on' ? 'on' : 'off',
    'editor.minimap': bool(r['editor.minimap'], DEFAULT_SETTINGS['editor.minimap']),
    'completion.enabled': bool(r['completion.enabled'], DEFAULT_SETTINGS['completion.enabled']),
    'completion.suggestOnSpace': bool(r['completion.suggestOnSpace'], DEFAULT_SETTINGS['completion.suggestOnSpace']),
    'completion.autoAlias': bool(r['completion.autoAlias'], DEFAULT_SETTINGS['completion.autoAlias']),
    'completion.snippets': bool(r['completion.snippets'], DEFAULT_SETTINGS['completion.snippets']),
    'completion.joinByForeignKey': bool(r['completion.joinByForeignKey'], DEFAULT_SETTINGS['completion.joinByForeignKey']),
    'completion.keywordCase': r['completion.keywordCase'] === 'lower' || r['completion.keywordCase'] === 'preserve' ? r['completion.keywordCase'] : 'upper',
    'query.pageSize': num(r['query.pageSize'], DEFAULT_SETTINGS['query.pageSize'], 10, 10000),
    'query.confirmDestructive': bool(r['query.confirmDestructive'], DEFAULT_SETTINGS['query.confirmDestructive']),
    'query.parameters.enabled': bool(r['query.parameters.enabled'], DEFAULT_SETTINGS['query.parameters.enabled']),
    'query.parameters.values': obj(r['query.parameters.values'], {}),
    'jdbc.jarPath': str(r['jdbc.jarPath'], ''),
    'jdbc.javaHome': str(r['jdbc.javaHome'], ''),
  }
}
