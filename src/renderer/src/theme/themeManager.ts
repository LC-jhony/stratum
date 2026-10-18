import type { AppearanceMode } from '../../../shared/settings'
import { ipc } from '../ipc/client'
import type { ThemeFile, ThemeManifestEntry } from '../../../shared/types'
import { applyColorTheme, themeKind, type ColorThemeJson } from './colorTheme'
import { fileIconFontCss, type FileIconThemeJson } from './fileIconTheme'
import { productIconCss, type ProductIconThemeJson } from './productIconTheme'
import { toMonacoTheme } from './monacoTheme'

export interface ActiveThemes { color?: ThemeFile; fileIcon?: ThemeFile; productIcon?: ThemeFile }
type Listener = () => void

/** Collapses entries that would show twice with the same kind and label (e.g. a VS Code extension copy of a bundled theme). Local files win over extensions. */
export function dedupeCatalog(entries: ThemeManifestEntry[]): { catalog: ThemeManifestEntry[]; aliases: Map<string, string> } {
  const key = (e: ThemeManifestEntry) => `${e.kind}:${e.label.trim().toLowerCase()}`
  const rank = (e: ThemeManifestEntry) => (e.source === 'user' ? 0 : e.source === 'builtin' ? 1 : 2)
  const best = new Map<string, ThemeManifestEntry>()
  for (const e of entries) { const k = key(e), cur = best.get(k); if (!cur || rank(e) < rank(cur)) best.set(k, e) }
  const aliases = new Map<string, string>()
  for (const e of entries) { const kept = best.get(key(e))!; if (kept.id !== e.id) aliases.set(e.id, kept.id) }
  return { catalog: entries.filter((e) => best.get(key(e)) === e), aliases }
}

/** True when a catalog entry is a light color theme (VS Code marks light themes with uiTheme 'vs'). */
const isLightEntry = (e: ThemeManifestEntry) => e.uiTheme === 'vs' || e.uiTheme === 'hc-light'

/** The entry's dark/light flavor when the catalog knows it (VS Code extensions may omit uiTheme). */
const entryKind = (e: ThemeManifestEntry): 'dark' | 'light' | undefined => (e.uiTheme ? (isLightEntry(e) ? 'light' : 'dark') : undefined)

/** Flavor guessed from the name for entries without uiTheme: "One Light" → light, "One Dark" → dark. */
const kindOfName = (s: string): 'dark' | 'light' | undefined => (/light/i.test(s) ? 'light' : /dark/i.test(s) ? 'dark' : undefined)

/** Swaps the kind word in a name: "Min Dark" → "Min light", "min-dark.json" → "min-light.json". */
const swapKindWord = (s: string, kind: 'dark' | 'light') => s.replace(/dark|light/i, kind)

/**
 * Theme to apply for `kind`: the active theme's sibling (Min Dark ↔ Min Light, Carbon Dark ↔ Carbon Light),
 * else the bundled Carbon theme of that kind, else any theme of that kind.
 */
export function siblingTheme(entry: ThemeManifestEntry | undefined, kind: 'dark' | 'light', catalog: ThemeManifestEntry[]): ThemeManifestEntry | undefined {
  const colors = catalog.filter((e) => e.kind === 'color')
  const matches = (e: ThemeManifestEntry) => entryKind(e) === undefined || entryKind(e) === kind
  if (entry) {
    const label = swapKindWord(entry.label, kind).trim().toLowerCase()
    const byLabel = colors.find((e) => e.label.trim().toLowerCase() === label && matches(e))
    if (byLabel) return byLabel
    const byId = colors.find((e) => e.id === swapKindWord(entry.id, kind))
    if (byId && byId !== entry && matches(byId)) return byId
  }
  return colors.find((e) => e.id === `builtin:carbon-${kind}.json`) ?? colors.find((e) => entryKind(e) === kind)
}

/** Color theme for a mode: keeps the current theme when its kind matches, otherwise switches to its sibling. */
export function pickThemeEntry(mode: AppearanceMode, osDark: boolean, catalog: ThemeManifestEntry[], current?: ThemeManifestEntry, currentKind?: 'dark' | 'light'): ThemeManifestEntry | undefined {
  const kind: 'dark' | 'light' = mode === 'system' ? (osDark ? 'dark' : 'light') : mode
  if (current && currentKind === kind) return current
  return siblingTheme(current, kind, catalog)
}

/** Owns the three independent theme slots (color, file icon, product icon), exactly like VS Code. */
class ThemeManager {
  active: ActiveThemes = {}
  catalog: ThemeManifestEntry[] = []
  /** Color mode from Settings: dark/light pin a theme kind, system follows the OS and reacts to switches. */
  mode: AppearanceMode = 'system'
  private listeners = new Set<Listener>()
  private styleEl = (id: string) => { let el = document.getElementById(id) as HTMLStyleElement | null; if (!el) { el = document.createElement('style'); el.id = id; document.head.appendChild(el) } return el }
  subscribe(l: Listener) { this.listeners.add(l); return () => void this.listeners.delete(l) }
  private emit() { this.listeners.forEach((l) => l()) }

  /** Re-reads the OS color scheme on every call so System mode always sees the current value. */
  private osDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches

  async init() {
    const [builtin, imported, settings] = await Promise.all([ipc.themes.list(), ipc.themes.importVsCodeExtensions().catch(() => []), ipc.settings.get()])
    const { catalog, aliases } = dedupeCatalog([...builtin, ...imported])
    this.catalog = catalog
    /** Resolves a persisted id; a duplicate dropped from the picker still resolves to the kept twin. */
    const find = (id: unknown, kind: ThemeManifestEntry['kind']) => typeof id !== 'string' ? undefined : this.catalog.find((e) => e.id === (aliases.get(id) ?? id) && e.kind === kind)
    const stored = settings['appearance.mode']
    const pinned = find(settings.colorTheme, 'color')
    const pinnedKind = pinned ? (entryKind(pinned) ?? kindOfName(pinned.label)) : undefined
    // A stored mode wins; installs that pinned a theme before Appearance existed keep it; fresh installs follow the OS.
    this.mode = stored === 'dark' || stored === 'light' || stored === 'system' ? stored : (pinnedKind ?? 'system')
    // Persist a derived mode: without it the store's default ('system') would override the pinned theme after load().
    if (this.mode !== stored) void ipc.settings.set({ 'appearance.mode': this.mode })
    const kind: 'dark' | 'light' = this.mode === 'system' ? (this.osDark() ? 'dark' : 'light') : this.mode
    const color = pinned && (pinnedKind === undefined || pinnedKind === kind) ? pinned : siblingTheme(pinned, kind, this.catalog)
    if (color) await this.set(color, false)
    const fi = find(settings.fileIconTheme, 'fileIcon'); if (fi) await this.set(fi, false)
    const pi = find(settings.productIconTheme, 'productIcon'); if (pi) await this.set(pi, false)
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (this.mode === 'system') void this.applyMode('system') })
    this.emit()
  }

  /** Applies the Settings color mode: forces a kind or follows the OS, switching to the active theme's sibling when needed. */
  async applyMode(mode: AppearanceMode) {
    const kind: 'dark' | 'light' = mode === 'system' ? (this.osDark() ? 'dark' : 'light') : mode
    const current = this.active.color
    const currentKind = current ? themeKind(current.json as ColorThemeJson) : undefined
    if (mode === this.mode && currentKind === kind) return
    this.mode = mode
    const entry = pickThemeEntry(mode, this.osDark(), this.catalog, current?.entry, currentKind)
    if (entry) await this.set(entry, false)
  }

  async set(entry: ThemeManifestEntry, persist = true) {
    const key = entry.kind
    const file = await ipc.themes.read(entry.path)
    this.active = { ...this.active, [key]: file }
    if (entry.kind === 'color') {
      const json = file.json as ColorThemeJson
      if (persist) this.mode = themeKind(json) // Picking a theme explicitly pins its kind, like VS Code.
      const colors = applyColorTheme(json)
      // colorScheme drives the native chrome (menu bar, dialogs) in the main process; 'system' keeps following the OS.
      void ipc.settings.set({ windowBackground: colors['editor.background'], colorScheme: this.mode === 'system' ? 'system' : themeKind(json) })
    } else if (entry.kind === 'fileIcon') {
      this.styleEl('stratum-file-icon-fonts').textContent = fileIconFontCss(file.json as FileIconThemeJson, file.baseUrl)
    } else {
      this.styleEl('stratum-product-icons').textContent = productIconCss(file.json as ProductIconThemeJson, file.baseUrl)
    }
    if (persist) await ipc.settings.set(entry.kind === 'color' ? { colorTheme: entry.id, 'appearance.mode': this.mode } : { [`${key}Theme`]: entry.id })
    this.emit()
  }
  /** Clear an icon theme (back to defaults). */
  async clear(kind: 'fileIcon' | 'productIcon') {
    this.active = { ...this.active, [kind]: undefined }
    this.styleEl(kind === 'fileIcon' ? 'stratum-file-icon-fonts' : 'stratum-product-icons').textContent = ''
    await ipc.settings.set({ [`${kind}Theme`]: null })
    this.emit()
  }
  monacoTheme() { return this.active.color ? toMonacoTheme(this.active.color.json as ColorThemeJson) : undefined }
}
export const themes = new ThemeManager()
