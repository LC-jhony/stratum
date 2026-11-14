/** User-editable application settings stored in <userData>/settings.json and shared by main + renderer. */

export type KeywordCase = 'upper' | 'lower' | 'preserve'
/** Color mode: pin dark/light or follow the OS (System). */
export type AppearanceMode = 'dark' | 'light' | 'system'
/** Side of the workbench activity bar + side bar (VS Code's "Side Bar: Position"). */
export type SideBarPosition = 'left' | 'right'
/** UI (chrome) font family: the bundled stacks, or a family typed by the user. */
export type UiFont = 'system' | 'mono' | 'serif' | 'custom'

export interface StratumSettings {
  /** Settings reflects the active color mode; dark/light pin a theme kind, system follows the OS. */
  'appearance.mode': AppearanceMode
  /** Interface family (rail, tree, dialogs); the editor keeps `editor.fontFamily`. */
  'appearance.uiFont': UiFont
  /** Family typed when `appearance.uiFont` is `custom` (sanitized, quoted ahead of the system stack). */
  'appearance.customFont': string
  /** Chrome text size in px (12–20). Monaco and the data grid keep their own density. */
  'appearance.fontSize': number
  /** Tighter control heights (valet dashboard's "Compact view"). */
  'appearance.compact': boolean
  /** Workbench activity bar and side bar side. */
  'workbench.sideBar.position': SideBarPosition
  /** Side bar visibility; the explorer stays mounted so expanding a tree survives a toggle. */
  'workbench.sideBar.visible': boolean
  /** Reopen SQL consoles with their text after a restart. */
  'workbench.restoreTabs': boolean
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
  /** Prefix CSV/TSV cells that a spreadsheet would run as a formula (=, +, -, @). */
  'export.neutralizeFormulas': boolean
  'jdbc.jarPath': string
  'jdbc.javaHome': string
  /** Check GitHub Releases shortly after launch and every four hours. */
  'update.autoCheck': boolean
  /** Download an available update in the background; installation still needs a restart. */
  'update.autoDownload': boolean
  /** Advanced free-form keys pass through to the JSON store untouched. */
  [key: string]: unknown
}

export const DEFAULT_SETTINGS: StratumSettings = {
  'appearance.mode': 'system',
  'appearance.uiFont': 'system',
  'appearance.customFont': '',
  'appearance.fontSize': 15,
  'appearance.compact': false,
  'workbench.sideBar.position': 'left',
  'workbench.sideBar.visible': true,
  'workbench.restoreTabs': true,
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
  'export.neutralizeFormulas': true,
  'jdbc.jarPath': '',
  'jdbc.javaHome': '',
  'update.autoCheck': true,
  'update.autoDownload': true,
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
    'appearance.uiFont': r['appearance.uiFont'] === 'mono' || r['appearance.uiFont'] === 'serif' || r['appearance.uiFont'] === 'custom' ? r['appearance.uiFont'] : 'system',
    'appearance.customFont': str(r['appearance.customFont'], '').slice(0, 120),
    'appearance.fontSize': num(r['appearance.fontSize'], DEFAULT_SETTINGS['appearance.fontSize'], 12, 20),
    'appearance.compact': bool(r['appearance.compact'], DEFAULT_SETTINGS['appearance.compact']),
    'workbench.sideBar.position': r['workbench.sideBar.position'] === 'right' ? 'right' : 'left',
    'workbench.sideBar.visible': bool(r['workbench.sideBar.visible'], DEFAULT_SETTINGS['workbench.sideBar.visible']),
    'workbench.restoreTabs': bool(r['workbench.restoreTabs'], DEFAULT_SETTINGS['workbench.restoreTabs']),
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
    'export.neutralizeFormulas': bool(r['export.neutralizeFormulas'], DEFAULT_SETTINGS['export.neutralizeFormulas']),
    'jdbc.jarPath': str(r['jdbc.jarPath'], ''),
    'jdbc.javaHome': str(r['jdbc.javaHome'], ''),
    'update.autoCheck': bool(r['update.autoCheck'], DEFAULT_SETTINGS['update.autoCheck']),
    'update.autoDownload': bool(r['update.autoDownload'], DEFAULT_SETTINGS['update.autoDownload']),
  }
}
