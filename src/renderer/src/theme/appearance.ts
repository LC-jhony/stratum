import type { StratumSettings, UiFont } from '../../../core/settings'

/** Interface font stacks. The editor keeps `--stratum-mono` / `editor.fontFamily`. */
export const UI_FONTS: Record<Exclude<UiFont, 'custom'>, string> = {
  system: '"Cantarell", "Ubuntu", "Noto Sans", "Inter", system-ui, sans-serif',
  mono: 'ui-monospace, "JetBrains Mono", "Ubuntu Mono", monospace',
  serif: '"Noto Serif", Georgia, "Times New Roman", serif',
}

export const MIN_UI_FONT_SIZE = 12
export const MAX_UI_FONT_SIZE = 20

/** Chrome text size, clamped to the range Settings offers. */
export function clampUiFontSize(value: unknown, fallback = 15): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_UI_FONT_SIZE, Math.max(MIN_UI_FONT_SIZE, Math.round(value)))
    : fallback
}

/**
 * CSS family for the interface. A custom family is reduced to letters, digits, spaces and
 * hyphens before quoting: the value goes straight into a CSS custom property, so quotes,
 * commas or semicolons typed by the user must never break out of the declaration.
 */
export function uiFontStack(font: UiFont, custom: string): string {
  if (font !== 'custom') return UI_FONTS[font]
  const family = custom.replace(/[^\w\s-]/g, '').trim()
  return family ? `"${family}", ${UI_FONTS.system}` : UI_FONTS.system
}

type AppearancePrefs = Pick<StratumSettings,
  'appearance.fontSize' | 'appearance.compact' | 'appearance.uiFont' | 'appearance.customFont'>

/** Custom properties for the appearance settings; pure so the thresholds stay testable. */
export function appearanceVars(prefs: AppearancePrefs): Record<string, string> {
  return {
    '--fs': `${clampUiFontSize(prefs['appearance.fontSize'])}px`,
    '--dense': prefs['appearance.compact'] ? '1' : '0',
    '--stratum-font': uiFontStack(prefs['appearance.uiFont'], prefs['appearance.customFont']),
  }
}

/** Applies text size, density and the interface family to the workbench root. */
export function applyAppearance(prefs: StratumSettings, root: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries(appearanceVars(prefs))) root.style.setProperty(name, value)
  root.dataset.compact = String(!!prefs['appearance.compact'])
}
