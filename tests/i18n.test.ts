import { describe, expect, it } from 'vitest'
import { CATALOG_SIZE, createTranslator, LOCALES, resolveLocale, translate } from '../src/core/i18n'
import { en } from '../src/core/i18n/en'
import { es } from '../src/core/i18n/es'

describe('locale resolution', () => {
  it('honours an explicit setting', () => {
    expect(resolveLocale('en', 'es-ES')).toBe('en')
    expect(resolveLocale('es', 'en-US')).toBe('es')
  })
  it('follows the system language when the setting is system or stale', () => {
    expect(resolveLocale('system', 'es-ES')).toBe('es')
    expect(resolveLocale('system', 'es')).toBe('es')
    expect(resolveLocale(undefined, 'en-GB')).toBe('en')
    expect(resolveLocale('klingon', 'fr-FR')).toBe('en')
  })
})

describe('translation lookup', () => {
  it('translates menu labels in both locales', () => {
    expect(translate('en', 'menu.file')).toBe('File')
    expect(translate('es', 'menu.file')).toBe('Archivo')
  })
  it('interpolates variables and leaves unknown placeholders intact', () => {
    expect(translate('en', 'menu.version', { version: '1.2.3' })).toBe('Version 1.2.3')
    expect(translate('es', 'extensions.footer', { enabled: 3, total: 5 })).toBe('3 de 5 activadas')
    expect(translate('en', 'menu.version')).toBe('Version {version}')
  })
  it('falls back to the key when it is unknown', () => {
    expect(translate('es', 'missing.key')).toBe('missing.key')
  })
  it('creates reusable translators', () => {
    const t = createTranslator('es')
    expect(t('common.close')).toBe('Cerrar')
  })
})

describe('catalog completeness', () => {
  it('ships both declared locales', () => expect(LOCALES).toEqual(['en', 'es']))
  it('has the same keys in English and Spanish', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort())
    expect(CATALOG_SIZE.en).toBe(CATALOG_SIZE.es)
  })
})
