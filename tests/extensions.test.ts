import { describe, expect, it } from 'vitest'
import { BUILTIN_EXTENSIONS } from '../src/main/extensions/builtin'
import { EXAMPLE_PLUGIN } from '../src/main/plugins/builtin/example'
import { validateExtension } from '../src/core/registry'

describe('bundled extension manifests', () => {
  const manifests = [...BUILTIN_EXTENSIONS, EXAMPLE_PLUGIN]

  it('are all valid', () => {
    for (const m of manifests) expect(validateExtension(m), m.id).toEqual([])
  })

  it('have unique ids', () => {
    expect(new Set(manifests.map((m) => m.id)).size).toBe(manifests.length)
  })

  it('mark the workbench as mandatory and ship at least one example plugin', () => {
    expect(manifests.find((m) => m.id === 'stratum.core')?.mandatory).toBe(true)
    expect(manifests.some((m) => m.id === 'stratum.example' && !m.mandatory)).toBe(true)
  })
})
