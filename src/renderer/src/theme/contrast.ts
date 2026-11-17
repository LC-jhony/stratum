/**
 * WCAG contrast helpers used to keep third-party themes legible.
 *
 * VS Code themes are authored by hand: a brand accent can look right and still fail AA when it
 * carries text (Carbon's red is 3.38:1 with white). These helpers preserve the author's hue and
 * saturation and move only the lightness that is needed, so a broken pair is repaired without
 * repainting the theme.
 */

export interface Rgb {
  r: number
  g: number
  b: number
  /** 0–1. */
  a: number
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** Parses the colour forms VS Code themes use (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`). */
export function parseHex(value: string | undefined): Rgb | undefined {
  if (!value) return undefined
  const match = value.trim().match(HEX)
  if (!match) return undefined
  let hex = match[1]
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('')
  const num = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16)
  return {
    r: num(0),
    g: num(2),
    b: num(4),
    a: hex.length === 8 ? num(6) / 255 : 1,
  }
}

/** Relative luminance (WCAG 2.1) of an opaque colour; alpha is ignored. */
export function luminance(value: string | undefined): number | undefined {
  const rgb = parseHex(value)
  if (!rgb) return undefined
  const channel = (c: number) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

/** WCAG contrast ratio between two colours, or undefined when either is not a hex colour. */
export function contrastRatio(a: string | undefined, b: string | undefined): number | undefined {
  const la = luminance(a)
  const lb = luminance(b)
  if (la === undefined || lb === undefined) return undefined
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const clamp = (value: number) => Math.min(1, Math.max(0, value))

const toHsl = (rgb: Rgb): [number, number, number] => {
  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (!d) return [0, 0, l]
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}

const fromHsl = (h: number, s: number, l: number): Rgb => {
  const channel = (t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return {
    r: Math.round(channel(h + 1 / 3) * 255),
    g: Math.round(channel(h) * 255),
    b: Math.round(channel(h - 1 / 3) * 255),
    a: 1,
  }
}

const toHex = (rgb: Rgb): string => {
  const part = (n: number) => Math.min(255, Math.max(0, n)).toString(16).padStart(2, '0')
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`
}

/** Moves a colour's lightness by `steps` of 1 %, keeping hue and saturation. */
function shift(value: string, steps: number): string | undefined {
  const rgb = parseHex(value)
  if (!rgb) return undefined
  const [h, s, l] = toHsl(rgb)
  return toHex(fromHsl(h, s, clamp(l + steps / 100)))
}

export interface ContrastFix {
  fg: string
  bg: string
  changed: boolean
}

/**
 * Ensures `fg` over `bg` reaches `target`.
 *
 * `adjust` chooses what the theme author would rather keep: `'bg'` keeps the text colour (filled
 * buttons and the status bar darken their surface), `'fg'` keeps the surface (text on a panel
 * becomes darker or lighter). Translucent colours are returned unchanged: their real backdrop is
 * not known here, and rewriting them would change the design instead of repairing it.
 */
export function ensureContrast(
  fg: string,
  bg: string,
  target = 4.5,
  adjust: 'fg' | 'bg' = 'fg',
): ContrastFix {
  const front = parseHex(fg)
  const back = parseHex(bg)
  const ratio = contrastRatio(fg, bg)
  if (!front || !back || front.a < 1 || back.a < 1 || ratio === undefined || ratio >= target) {
    return { fg, bg, changed: false }
  }

  const frontLight = luminance(fg)! >= luminance(bg)!
  // Light text gets a darker surface; dark text gets a lighter one. The other direction moves
  // away from the text and can never increase contrast.
  const direction = adjust === 'bg'
    ? (frontLight ? -1 : 1)
    : (frontLight ? 1 : -1)
  const key = adjust === 'bg' ? 'bg' : 'fg'
  const original = key === 'bg' ? bg : fg

  for (let step = 1; step <= 100; step++) {
    const candidate = shift(original, direction * step)
    if (!candidate) break
    const next = key === 'bg' ? { fg, bg: candidate } : { fg: candidate, bg }
    const reached = contrastRatio(next.fg, next.bg)
    if (reached !== undefined && reached >= target) return { ...next, changed: true }
  }

  // Mid-tone pairs can run out of lightness in the chosen direction. Black or white text is the
  // last resort; the surface is preferred, but legibility wins over an unreadable combination.
  const candidates = ['#000000', '#FFFFFF']
  const ink = candidates.find((c) => (contrastRatio(c, bg) ?? 0) >= target)
  if (ink) return { fg: ink, bg, changed: ink !== fg }
  return { fg, bg, changed: false }
}

interface Pair {
  fg: string
  bg: string
  target: number
  adjust: 'fg' | 'bg'
}

/**
 * Chrome pairs the workbench paints as text or icons. Editor colours are deliberately absent:
 * Monaco renders the raw theme, so repairing `editor.*` here would desynchronise the editor from
 * the rest of the window.
 */
const PAIRS: Pair[] = [
  { fg: 'button.foreground', bg: 'button.background', target: 4.5, adjust: 'bg' },
  { fg: 'statusBar.foreground', bg: 'statusBar.background', target: 4.5, adjust: 'bg' },
  { fg: 'activityBar.foreground', bg: 'activityBar.background', target: 3, adjust: 'fg' },
  { fg: 'sideBar.foreground', bg: 'sideBar.background', target: 4.5, adjust: 'fg' },
  { fg: 'menu.foreground', bg: 'menu.background', target: 4.5, adjust: 'fg' },
  { fg: 'input.foreground', bg: 'input.background', target: 4.5, adjust: 'fg' },
  { fg: 'tab.activeForeground', bg: 'tab.activeBackground', target: 4.5, adjust: 'fg' },
  { fg: 'list.activeSelectionForeground', bg: 'list.activeSelectionBackground', target: 4.5, adjust: 'bg' },
]

/**
 * Returns a repaired copy of a resolved colour map. Keys whose pair is missing, translucent or
 * already compliant are left byte-for-byte identical.
 */
export function repairContrast(colors: Record<string, string>): Record<string, string> {
  const out = { ...colors }
  for (const pair of PAIRS) {
    const fg = out[pair.fg]
    const bg = out[pair.bg]
    if (!fg || !bg) continue
    const fix = ensureContrast(fg, bg, pair.target, pair.adjust)
    if (!fix.changed) continue
    out[pair.fg] = fix.fg
    out[pair.bg] = fix.bg
  }
  return out
}
