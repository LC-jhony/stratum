import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '../src/shared/settings'

describe('appearance.mode coercion', () => {
  it('defaults to system', () => expect(mergeSettings(undefined)['appearance.mode']).toBe(DEFAULT_SETTINGS['appearance.mode']))
  it('keeps dark and light', () => {
    expect(mergeSettings({ 'appearance.mode': 'dark' })['appearance.mode']).toBe('dark')
    expect(mergeSettings({ 'appearance.mode': 'light' })['appearance.mode']).toBe('light')
  })
  it('rejects unknown values', () => expect(mergeSettings({ 'appearance.mode': 'sepia' })['appearance.mode']).toBe('system'))
})

describe('workbench.sideBar.position coercion', () => {
  it('defaults to left', () => expect(mergeSettings(undefined)['workbench.sideBar.position']).toBe('left'))
  it('keeps right', () => expect(mergeSettings({ 'workbench.sideBar.position': 'right' })['workbench.sideBar.position']).toBe('right'))
  it('rejects unknown values', () => expect(mergeSettings({ 'workbench.sideBar.position': 'center' })['workbench.sideBar.position']).toBe('left'))
})

describe('editor.fontFamily coercion', () => {
  it('defaults to the built-in chain', () => expect(DEFAULT_SETTINGS['editor.fontFamily']).toBe(''))
  it('keeps a family name and ignores non-strings', () => {
    expect(mergeSettings({ 'editor.fontFamily': 'Fira Code' })['editor.fontFamily']).toBe('Fira Code')
    expect(mergeSettings({ 'editor.fontFamily': 7 })['editor.fontFamily']).toBe('')
  })
  it('caps runaway values', () => expect(mergeSettings({ 'editor.fontFamily': 'x'.repeat(300) })['editor.fontFamily']).toHaveLength(200))
})
