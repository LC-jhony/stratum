import type { StratumSettings } from '../../../shared/settings'

/** Default monospace chain — keep in sync with `--stratum-mono` in styles.css. */
export const MONO_FALLBACK = '"JetBrains Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

/** Families offered as suggestions in Settings; any installed font can be typed instead. */
export const MONO_FONTS = ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Cascadia Mono', 'Source Code Pro', 'IBM Plex Mono', 'Hack', 'Inconsolata', 'Ubuntu Mono', 'SF Mono', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace']

/**
 * Editor font stack for a Settings value: empty keeps the default chain, a bare family name is
 * quoted ahead of it, and a full stack (quotes, commas or a generic keyword) passes through.
 */
export function monoFontStack(family: string): string {
  const f = family.trim()
  if (!f) return MONO_FALLBACK
  if (/["',]/.test(f) || f === 'monospace') return f
  return `"${f}", ${MONO_FALLBACK}`
}

/** Applies the font preferences to the workbench root; `--stratum-mono` styles the grid, code and Monaco. */
export function applyFontPrefs(prefs: StratumSettings, root: HTMLElement = document.documentElement): void {
  root.style.setProperty('--stratum-mono', monoFontStack(prefs['editor.fontFamily']))
}

/** Chromium's Local Font Access API is not in the DOM lib yet. */
interface LocalFontAccess { queryLocalFonts?: () => Promise<{ family: string }[]> }
let systemFontsCache: string[] | undefined

/** Every installed font family (Chromium's Local Font Access API); empty when unavailable or denied. */
export async function systemFonts(): Promise<string[]> {
  if (systemFontsCache) return systemFontsCache
  const q = (window as unknown as LocalFontAccess).queryLocalFonts
  if (!q) return []
  try {
    const list = await q.call(window)
    systemFontsCache = [...new Set(list.map((f) => f.family).filter(Boolean))].sort((a, b) => a.localeCompare(b))
    return systemFontsCache
  } catch { return [] }
}
