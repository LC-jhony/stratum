import type { AppearanceMode } from '../../../core/settings'
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

/** The kind a mode resolves to; System asks the OS. */
export const kindForMode = (mode: AppearanceMode, osDark: boolean): 'dark' | 'light' => mode === 'system' ? (osDark ? 'dark' : 'light') : mode

export type PaletteId = 'carbon' | 'min'
export type FileIconThemeId = 'dawn' | 'deep' | 'dim' | 'you'

const paletteLabel = (id: PaletteId) => id === 'carbon' ? 'Carbon' : 'Min'

/** Family of a built-in color palette. Labels are matched because dedupe may keep a user override. */
export function paletteOf(entry: ThemeManifestEntry | undefined): PaletteId | undefined {
  if (!entry || entry.kind !== 'color') return undefined
  const label = entry.label.trim().toLowerCase()
  if (/^carbon(?:\s+(?:dark|light))?$/.test(label)) return 'carbon'
  if (/^min(?:\s+(?:dark|light))?$/.test(label)) return 'min'
  const builtin = entry.source === 'builtin' ? /^builtin:(carbon|min)-(?:dark|light)\.json$/.exec(entry.id) : null
  return builtin ? builtin[1] as PaletteId : undefined
}

/** The palette variant for a mode: Carbon Dark/Light or Min Dark/Light. */
export function paletteTheme(family: PaletteId, mode: AppearanceMode, osDark: boolean, catalog: ThemeManifestEntry[]): ThemeManifestEntry | undefined {
  const kind = kindForMode(mode, osDark)
  const label = `${paletteLabel(family)} ${kind === 'dark' ? 'Dark' : 'Light'}`
  return catalog.find((e) => e.kind === 'color' && paletteOf(e) === family && e.label.trim().toLowerCase() === label.toLowerCase())
    ?? catalog.find((e) => e.kind === 'color' && e.source === 'builtin' && e.id === `builtin:${family}-${kind}.json`)
}

/** Family of a bundled file icon theme; `undefined` for None or an imported theme. */
export function fileIconFamily(entry: ThemeManifestEntry | undefined): FileIconThemeId | undefined {
  if (!entry || entry.kind !== 'fileIcon') return undefined
  const label = entry.label.trim().toLowerCase()
  if (label === 'dawn' || label === 'deep' || label === 'dim' || label === 'you') return label
  const builtin = entry.source === 'builtin' ? /^builtin:(dawn|deep|dim|you)\.json$/.exec(entry.id) : null
  return builtin ? builtin[1] as FileIconThemeId : undefined
}

/** The bundled file icon theme for a family. Its `light` associations follow the active palette. */
export function fileIconTheme(family: FileIconThemeId, catalog: ThemeManifestEntry[]): ThemeManifestEntry | undefined {
  return catalog.find((e) => e.kind === 'fileIcon' && fileIconFamily(e) === family)
}

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
  const kind = kindForMode(mode, osDark)
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
  /** Per-slot ticket: the last selection to start wins even if an older read resolves later. */
  private seq: Record<keyof ActiveThemes, number> = { color: 0, fileIcon: 0, productIcon: 0 }
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
    // A stored mode wins; installs that pinned a theme before Appearance existed keep it;
    // SettingsService supplies 'dark' for a first run, so fresh installs start dark.
    this.mode = stored === 'dark' || stored === 'light' || stored === 'system' ? stored : (pinnedKind ?? 'system')
    // Persist a derived mode: without it the store's default ('system') would override the pinned theme after load().
    if (this.mode !== stored) void ipc.settings.set({ 'appearance.mode': this.mode })
    const kind = kindForMode(this.mode, this.osDark())
    const color = pinned && (pinnedKind === undefined || pinnedKind === kind) ? pinned : siblingTheme(pinned, kind, this.catalog)
    if (color) await this.set(color, false)
    const fi = find(settings.fileIconTheme, 'fileIcon'); if (fi) await this.set(fi, false)
    const pi = find(settings.productIconTheme, 'productIcon'); if (pi) await this.set(pi, false)
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (this.mode === 'system') void this.applyMode('system') })
    this.emit()
  }

  /** Applies the Settings color mode: forces a kind or follows the OS, switching to the active theme's sibling when needed. */
  async applyMode(mode: AppearanceMode) {
    const kind = kindForMode(mode, this.osDark())
    const current = this.active.color
    const currentKind = current ? themeKind(current.json as ColorThemeJson) : undefined
    if (mode === this.mode && currentKind === kind) return
    this.mode = mode
    const entry = pickThemeEntry(mode, this.osDark(), this.catalog, current?.entry, currentKind)
    if (entry) await this.set(entry, false)
  }

  async set(entry: ThemeManifestEntry, persist = true) {
    const key = entry.kind
    const ticket = ++this.seq[key]
    const file = await ipc.themes.read(entry.path)
    // A quick second click can start before this read resolves; the newest pick owns the slot.
    if (ticket !== this.seq[key]) return
    this.active = { ...this.active, [key]: file }
    if (entry.kind === 'color') {
      const json = file.json as ColorThemeJson
      if (persist) this.mode = themeKind(json) // Picking a theme explicitly pins its kind, like VS Code.
      const colors = applyColorTheme(json)
      // colorScheme drives the native chrome (menu bar, dialogs) in the main process; 'system' keeps following the OS.
      // The title-bar colours feed the Windows caption overlay so its buttons match the editor chrome.
      void ipc.settings.set({
        windowBackground: colors['editor.background'],
        colorScheme: this.mode === 'system' ? 'system' : themeKind(json),
        titleBarBackground: colors['titleBar.activeBackground'] ?? colors['editor.background'],
        titleBarForeground: colors['titleBar.activeForeground'] ?? colors['foreground'],
      })
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
    this.seq[kind]++ // a read already in flight must not restore the theme we are clearing
    this.active = { ...this.active, [kind]: undefined }
    this.styleEl(kind === 'fileIcon' ? 'stratum-file-icon-fonts' : 'stratum-product-icons').textContent = ''
    await ipc.settings.set({ [`${kind}Theme`]: null })
    this.emit()
  }
  monacoTheme() { return this.active.color ? toMonacoTheme(this.active.color.json as ColorThemeJson) : undefined }
}
export const themes = new ThemeManager()
