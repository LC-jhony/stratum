import { describe, expect, it } from 'vitest'
import { DIALECTS } from '../src/core/dialects'
import { ENGINE_PRESETS, enginePreset, urlForEngine } from '../src/core/engines'

describe('ENGINE_PRESETS', () => {
  it('has unique ids and dialect entries for every preset', () => {
    const ids = ENGINE_PRESETS.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    const dialects = new Set(DIALECTS.map((d) => d.id))
    for (const preset of ENGINE_PRESETS) expect(dialects.has(preset.dialect)).toBe(true)
  })

  it('uses JDBC URLs and sensible default ports', () => {
    for (const preset of ENGINE_PRESETS) {
      expect(preset.url.startsWith('jdbc:')).toBe(true)
      if (preset.port !== undefined) expect(preset.port).toBeGreaterThan(0)
    }
  })

  it('finds a preset by dialect', () => {
    expect(enginePreset('snowflake')?.label).toBe('Snowflake')
    expect(enginePreset('postgres')).toBeUndefined()
  })
})

describe('urlForEngine', () => {
  const snowflake = ENGINE_PRESETS.find((e) => e.id === 'snowflake')!

  it('keeps a URL typed for the same engine', () => {
    expect(urlForEngine({ url: 'jdbc:snowflake://custom', dialect: 'snowflake' }, snowflake)).toBe('jdbc:snowflake://custom')
  })

  it('replaces a URL that belonged to another engine', () => {
    expect(urlForEngine({ url: 'jdbc:oracle:thin:@localhost:1521/XE', dialect: 'oracle' }, snowflake)).toBe(snowflake.url)
    expect(urlForEngine(undefined, snowflake)).toBe(snowflake.url)
  })
})
