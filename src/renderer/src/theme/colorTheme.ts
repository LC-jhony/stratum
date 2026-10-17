export interface TokenColorRule { name?: string; scope?: string | string[]; settings: { foreground?: string; background?: string; fontStyle?: string } }
export interface ColorThemeJson {
  name?: string; type?: 'dark' | 'light' | 'hc' | 'hcLight'
  colors?: Record<string, string>; tokenColors?: TokenColorRule[]; semanticTokenColors?: Record<string, unknown>
}
export type ThemeKind = 'dark' | 'light'

/** Keys the workbench consumes. A third-party theme that omits any still gets a coherent UI. */
const DEFAULTS: Record<ThemeKind, Record<string, string>> = {
  dark: {
    foreground: '#cccccc', descriptionForeground: '#9d9d9d', focusBorder: '#007fd4', errorForeground: '#f48771',
    'editor.background': '#1e1e1e', 'editor.foreground': '#d4d4d4', 'editorLineNumber.foreground': '#858585',
    'sideBar.background': '#252526', 'sideBar.foreground': '#cccccc', 'sideBarSectionHeader.background': '#00000030',
    'activityBar.background': '#333333', 'activityBar.foreground': '#ffffff',
    'statusBar.background': '#007acc', 'statusBar.foreground': '#ffffff', 'titleBar.activeBackground': '#3c3c3c',
    'panel.background': '#1e1e1e', 'tab.activeBackground': '#1e1e1e', 'tab.inactiveBackground': '#2d2d2d', 'tab.hoverBackground': '#1e1e1e',
    'tab.activeForeground': '#ffffff', 'tab.inactiveForeground': '#ffffff80',
    'list.hoverBackground': '#2a2d2e', 'list.activeSelectionBackground': '#04395e', 'list.activeSelectionForeground': '#ffffff',
    'list.inactiveSelectionBackground': '#37373d', 'input.background': '#3c3c3c', 'input.foreground': '#cccccc',
    'button.background': '#0e639c', 'button.foreground': '#ffffff', 'button.hoverBackground': '#1177bb',
    'editorWidget.background': '#252526', 'menu.background': '#252526', 'menu.foreground': '#cccccc',
    'tree.tableOddRowsBackground': '#ffffff08', 'scrollbarSlider.background': '#79797966', 'scrollbarSlider.hoverBackground': '#646464b3', 'scrollbarSlider.activeBackground': '#bfbfbf66',
    'charts.foreground': '#cccccc', 'charts.lines': '#cccccc80',
    'charts.red': '#f14c4c', 'charts.blue': '#3794ff', 'charts.yellow': '#cca700', 'charts.orange': '#d18616', 'charts.green': '#89d185', 'charts.purple': '#b180d7',
    'terminal.ansiRed': '#cd3131', 'editorError.foreground': '#f14c4c', 'editorWarning.foreground': '#cca700',
  },
  light: {
    foreground: '#616161', descriptionForeground: '#717171', focusBorder: '#0090f1', errorForeground: '#a1260d',
    'editor.background': '#ffffff', 'editor.foreground': '#000000', 'editorLineNumber.foreground': '#237893',
    'sideBar.background': '#f3f3f3', 'sideBar.foreground': '#616161', 'sideBarSectionHeader.background': '#00000010',
    'activityBar.background': '#2c2c2c', 'activityBar.foreground': '#ffffff',
    'statusBar.background': '#007acc', 'statusBar.foreground': '#ffffff', 'titleBar.activeBackground': '#dddddd',
    'panel.background': '#ffffff', 'tab.activeBackground': '#ffffff', 'tab.inactiveBackground': '#ececec', 'tab.hoverBackground': '#ffffff',
    'tab.activeForeground': '#333333', 'tab.inactiveForeground': '#33333380',
    'list.hoverBackground': '#e8e8e8', 'list.activeSelectionBackground': '#0060c0', 'list.activeSelectionForeground': '#ffffff',
    'list.inactiveSelectionBackground': '#e4e6f1', 'input.background': '#ffffff', 'input.foreground': '#616161',
    'button.background': '#007acc', 'button.foreground': '#ffffff', 'button.hoverBackground': '#0062a3',
    'editorWidget.background': '#f3f3f3', 'menu.background': '#ffffff', 'menu.foreground': '#616161',
    'tree.tableOddRowsBackground': '#0000000a', 'scrollbarSlider.background': '#64646466', 'scrollbarSlider.hoverBackground': '#646464b3', 'scrollbarSlider.activeBackground': '#646464e6',
    'charts.foreground': '#616161', 'charts.lines': '#61616180',
    'charts.red': '#e51400', 'charts.blue': '#1a85ff', 'charts.yellow': '#bf8803', 'charts.orange': '#d18616', 'charts.green': '#388a34', 'charts.purple': '#652d90',
    'terminal.ansiRed': '#cd3131', 'editorError.foreground': '#e51400', 'editorWarning.foreground': '#bf8803',
  },
}

/** When a theme lacks a border key, borrow the nearest one it does define (mirrors VS Code's own fallbacks). */
const CHAIN: Record<string, string[]> = {
  'tree.tableColumnsBorder': ['panel.border', 'editorGroup.border', 'sideBar.border'],
  'panel.border': ['editorGroup.border', 'sideBar.border', 'contrastBorder'],
  'sideBar.border': ['panel.border', 'editorGroup.border'],
  'editorGroup.border': ['panel.border', 'sideBar.border'],
  'tab.border': ['editorGroup.border', 'panel.border'],
  'activityBar.border': ['sideBar.border', 'panel.border'],
  'statusBar.border': ['panel.border', 'editorGroup.border'],
  'titleBar.border': ['panel.border', 'editorGroup.border'],
  'input.border': ['panel.border', 'editorGroup.border'],
  'menu.border': ['panel.border', 'editorGroup.border'],
  'editorWidget.border': ['panel.border', 'editorGroup.border'],
  'sideBarSectionHeader.border': ['sideBar.border', 'panel.border'],
  'charts.lines': ['descriptionForeground'],
}
const EVERY_CHAIN_KEY = Object.keys(CHAIN)
const FALLBACK_BORDER = '#80808059'

export const themeKind = (t: ColorThemeJson): ThemeKind => (t.type === 'light' || t.type === 'hcLight' ? 'light' : 'dark')

export function resolveColors(theme: ColorThemeJson): Record<string, string> {
  const kind = themeKind(theme), own = theme.colors ?? {}
  const out: Record<string, string> = { ...DEFAULTS[kind], ...own }
  for (const key of EVERY_CHAIN_KEY) {
    if (own[key]) continue
    const donor = CHAIN[key].find((k) => own[k])
    if (donor) out[key] = own[donor]
    else if (/border$/i.test(key) && !out[key]) out[key] = FALLBACK_BORDER // no border anywhere: a faint neutral hairline beats an invisible one
  }
  // VS Code derives this one from the active colour (40% alpha) instead of hard-coding it, so a theme with a
  // light activity bar (Min Light) does not inherit the white meant for dark bars, which would be invisible.
  if (!own['activityBar.inactiveForeground']) {
    const fg = out['activityBar.foreground']
    if (/^#[0-9a-f]{6}$/i.test(fg)) out['activityBar.inactiveForeground'] = `${fg}66`
  }
  return out
}

/** `editor.background` -> `--vscode-editor-background` (same convention as VS Code, so snippets and extensions port over). */
export const cssVarName = (key: string) => `--vscode-${key.replace(/\./g, '-')}`

export function toCssVars(colors: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(colors).map(([k, v]) => [cssVarName(k), v]))
}

const appliedVars = new WeakMap<HTMLElement, string[]>()

export function applyColorTheme(theme: ColorThemeJson, root: HTMLElement = document.documentElement) {
  const colors = resolveColors(theme)
  const vars = toCssVars(colors)
  // Drop properties the previous theme set but this one does not: without this a partial theme
  // (Min Light after Carbon Dark) keeps stale colours, e.g. a dark toolbar strip in a light UI.
  for (const name of appliedVars.get(root) ?? []) if (!(name in vars)) root.style.removeProperty(name)
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  appliedVars.set(root, Object.keys(vars))
  root.dataset.theme = themeKind(theme)
  root.style.colorScheme = themeKind(theme)
  return colors
}
