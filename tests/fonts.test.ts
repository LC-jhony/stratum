import { describe, expect, it } from 'vitest'
import { MONO_FALLBACK, monoFontStack } from '../src/renderer/src/theme/fonts'

describe('monoFontStack', () => {
  it('keeps the default chain when no family is set', () => {
    expect(monoFontStack('')).toBe(MONO_FALLBACK)
    expect(monoFontStack('   ')).toBe(MONO_FALLBACK)
  })
  it('quotes a bare family ahead of the default chain', () => expect(monoFontStack('Fira Code')).toBe(`"Fira Code", ${MONO_FALLBACK}`))
  it('passes full stacks and generic keywords through', () => {
    expect(monoFontStack('"Iosevka Term", monospace')).toBe('"Iosevka Term", monospace')
    expect(monoFontStack('monospace')).toBe('monospace')
  })
})
