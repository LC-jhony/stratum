import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '../src/core/settings'

describe('appearance.mode coercion', () => {
  it('defaults to system', () => expect(mergeSettings(undefined)['appearance.mode']).toBe(DEFAULT_SETTINGS['appearance.mode']))
  it('keeps dark and light', () => {
    expect(mergeSettings({ 'appearance.mode': 'dark' })['appearance.mode']).toBe('dark')
    expect(mergeSettings({ 'appearance.mode': 'light' })['appearance.mode']).toBe('light')
  })
  it('rejects unknown values', () => expect(mergeSettings({ 'appearance.mode': 'sepia' })['appearance.mode']).toBe('system'))
})

describe('fileIconTheme default', () => {
  it('starts with Dawn and still allows an explicit None', () => {
    expect(mergeSettings(undefined)['fileIconTheme']).toBe('builtin:dawn.json')
    expect(mergeSettings({ fileIconTheme: null })['fileIconTheme']).toBeNull()
    expect(mergeSettings({ fileIconTheme: 'user:custom.json' })['fileIconTheme']).toBe('user:custom.json')
  })
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

describe('language and extension settings', () => {
  it('defaults to the system language with no disabled extensions', () => {
    expect(mergeSettings(undefined)['app.locale']).toBe('system')
    expect(mergeSettings(undefined)['extensions.disabled']).toEqual([])
  })
  it('keeps pinned locales and rejects stale values', () => {
    expect(mergeSettings({ 'app.locale': 'es' })['app.locale']).toBe('es')
    expect(mergeSettings({ 'app.locale': 'en' })['app.locale']).toBe('en')
    expect(mergeSettings({ 'app.locale': 'fr' })['app.locale']).toBe('system')
    expect(mergeSettings({ 'app.locale': 7 })['app.locale']).toBe('system')
  })
  it('deduplicates, trims and ignores non-strings in the disabled list', () => {
    expect(mergeSettings({ 'extensions.disabled': [' stratum.example ', 'stratum.example', '', 7, null, 'stratum.erd'] })['extensions.disabled'])
      .toEqual(['stratum.example', 'stratum.erd'])
    expect(mergeSettings({ 'extensions.disabled': 'stratum.example' })['extensions.disabled']).toEqual([])
  })
})

describe('workspace and update preferences', () => {
  it('defaults to restoring consoles and checking for updates', () => {
    expect(mergeSettings(undefined)['workbench.restoreTabs']).toBe(true)
    expect(mergeSettings(undefined)['update.autoCheck']).toBe(true)
    expect(mergeSettings(undefined)['update.autoDownload']).toBe(true)
  })
  it('keeps explicit booleans', () => {
    const s = mergeSettings({ 'workbench.restoreTabs': false, 'update.autoCheck': false, 'update.autoDownload': false })
    expect(s['workbench.restoreTabs']).toBe(false)
    expect(s['update.autoCheck']).toBe(false)
    expect(s['update.autoDownload']).toBe(false)
  })
  it('rejects non-boolean values', () => {
    const s = mergeSettings({ 'workbench.restoreTabs': 'no', 'update.autoCheck': 0, 'update.autoDownload': null })
    expect(s['workbench.restoreTabs']).toBe(true)
    expect(s['update.autoCheck']).toBe(true)
    expect(s['update.autoDownload']).toBe(true)
  })
})
