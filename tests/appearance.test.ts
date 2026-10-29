import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '../src/core/settings'
import { appearanceVars, applyAppearance, clampUiFontSize, uiFontStack, UI_FONTS } from '../src/renderer/src/theme/appearance'

describe('appearance defaults', () => {
  it('ships the valet scale: 15 px chrome, system family, comfortable density', () => {
    expect(DEFAULT_SETTINGS['appearance.fontSize']).toBe(15)
    expect(DEFAULT_SETTINGS['appearance.uiFont']).toBe('system')
    expect(DEFAULT_SETTINGS['appearance.customFont']).toBe('')
    expect(DEFAULT_SETTINGS['appearance.compact']).toBe(false)
  })
})

describe('appearance coercion', () => {
  it('clamps the text size to 12–20', () => {
    expect(mergeSettings({ 'appearance.fontSize': 8 })['appearance.fontSize']).toBe(12)
    expect(mergeSettings({ 'appearance.fontSize': 30 })['appearance.fontSize']).toBe(20)
    expect(mergeSettings({ 'appearance.fontSize': 15.6 })['appearance.fontSize']).toBe(16)
    expect(mergeSettings({ 'appearance.fontSize': 'big' })['appearance.fontSize']).toBe(15)
  })
  it('accepts the four families and rejects anything else', () => {
    for (const f of ['system', 'mono', 'serif', 'custom'] as const) expect(mergeSettings({ 'appearance.uiFont': f })['appearance.uiFont']).toBe(f)
    expect(mergeSettings({ 'appearance.uiFont': 'comic' })['appearance.uiFont']).toBe('system')
  })
  it('caps the custom family name', () => {
    expect(mergeSettings({ 'appearance.customFont': 'x'.repeat(300) })['appearance.customFont']).toHaveLength(120)
  })
  it('keeps compact as a boolean', () => {
    expect(mergeSettings({ 'appearance.compact': true })['appearance.compact']).toBe(true)
    expect(mergeSettings({ 'appearance.compact': 'yes' })['appearance.compact']).toBe(false)
  })
})

describe('font stacks', () => {
  it('returns a family chain per option', () => {
    expect(uiFontStack('system', '')).toContain('system-ui')
    expect(uiFontStack('mono', '')).toContain('monospace')
    expect(uiFontStack('serif', '')).toContain('Georgia')
  })
  it('quotes a custom family ahead of the system stack', () => {
    expect(uiFontStack('custom', 'Fira Sans')).toBe(`"Fira Sans", ${UI_FONTS.system}`)
  })
  it('cannot break out of the CSS declaration or fall back to nothing', () => {
    const stack = uiFontStack('custom', 'Evil"; color: red;')
    expect(stack).not.toContain(';')
    expect(stack.startsWith('"Evil')).toBe(true)
    expect(uiFontStack('custom', '   ')).toBe(UI_FONTS.system)
  })
})

describe('appearance variables', () => {
  const base = mergeSettings({})
  it('maps text size and density to the chrome tokens', () => {
    expect(appearanceVars(base)).toMatchObject({ '--fs': '15px', '--dense': '0' })
    const compact = mergeSettings({ 'appearance.compact': true, 'appearance.fontSize': 18 })
    expect(appearanceVars(compact)).toMatchObject({ '--fs': '18px', '--dense': '1' })
  })
  it('clamps out-of-range persisted values on the way in', () => {
    expect(appearanceVars({ ...base, 'appearance.fontSize': 99 })['--fs']).toBe('20px')
    expect(appearanceVars({ ...base, 'appearance.fontSize': 1 })['--fs']).toBe('12px')
  })
  it('writes the properties and the compact flag onto the root', () => {
    const props: Record<string, string> = {}
    const root = { style: { setProperty: (k: string, v: string) => { props[k] = v } }, dataset: {} } as unknown as HTMLElement
    applyAppearance(mergeSettings({ 'appearance.compact': true, 'appearance.fontSize': 16 }), root)
    expect(props['--fs']).toBe('16px')
    expect(props['--dense']).toBe('1')
    expect(root.dataset.compact).toBe('true')
  })
})

describe('clampUiFontSize', () => {
  it('falls back for non-numbers and rounds the rest', () => {
    expect(clampUiFontSize(undefined)).toBe(15)
    expect(clampUiFontSize('14')).toBe(15)
    expect(clampUiFontSize(13.7)).toBe(14)
  })
})
