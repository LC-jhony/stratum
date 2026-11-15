import { describe, expect, it } from 'vitest'
import { DuplicateExtensionError, ExtensionRegistry, InvalidExtensionError, validateExtension } from '../src/core/registry'
import type { ExtensionManifest } from '../src/shared/extensions'

const manifest = (patch: Partial<ExtensionManifest> = {}): ExtensionManifest => ({
  id: 'acme.demo',
  name: 'Demo',
  version: '1.0.0',
  description: 'Reference manifest for tests.',
  kind: 'plugin',
  priority: 10,
  builtin: false,
  ...patch,
})

describe('manifest validation', () => {
  it('accepts a complete manifest', () => expect(validateExtension(manifest())).toEqual([]))
  it('rejects malformed ids, versions and kinds', () => {
    const errors = validateExtension(manifest({ id: 'Bad Id', version: '1.0', kind: 'widget' as never, priority: -1 }))
    expect(errors.join(' ')).toContain('id')
    expect(errors.join(' ')).toContain('version')
    expect(errors.join(' ')).toContain('kind')
    expect(errors.join(' ')).toContain('priority')
  })
  it('rejects duplicate command ids and empty titles', () => {
    const errors = validateExtension(manifest({ commands: [{ id: 'demo.run', title: '' }, { id: 'demo.run', title: 'Run' }] }))
    expect(errors.join(' ')).toContain('duplicate command id')
    expect(errors.join(' ')).toContain('title')
  })
  it('rejects duplicate drivers', () => {
    expect(validateExtension(manifest({ drivers: ['postgres', 'postgres'] })).join(' ')).toContain('unique')
  })
  it('throws a typed error from register', () => {
    expect(() => new ExtensionRegistry().register(manifest({ version: 'x' }))).toThrow(InvalidExtensionError)
  })
})

describe('ExtensionRegistry', () => {
  it('registers and reads back a copy', () => {
    const registry = new ExtensionRegistry()
    registry.register(manifest())
    expect(registry.size).toBe(1)
    expect(registry.get('acme.demo')?.name).toBe('Demo')
  })

  it('rejects a duplicate with equal or lower priority', () => {
    const registry = new ExtensionRegistry()
    registry.register(manifest({ priority: 20 }))
    expect(() => registry.register(manifest({ priority: 20 }))).toThrow(DuplicateExtensionError)
    expect(() => registry.register(manifest({ priority: 10 }))).toThrow(DuplicateExtensionError)
  })

  it('lets a strictly higher priority replace an existing manifest', () => {
    const registry = new ExtensionRegistry()
    registry.register(manifest({ priority: 10, description: 'old' }))
    registry.register(manifest({ priority: 11, description: 'new' }))
    expect(registry.size).toBe(1)
    expect(registry.get('acme.demo')?.description).toBe('new')
  })

  it('sorts by priority then name and keeps the order stable', () => {
    const registry = new ExtensionRegistry()
    registry.register(manifest({ id: 'acme.b', name: 'Beta', priority: 10 }))
    registry.register(manifest({ id: 'acme.a', name: 'Alpha', priority: 10 }))
    registry.register(manifest({ id: 'acme.c', name: 'Core', priority: 99 }))
    expect(registry.list().map((m) => m.id)).toEqual(['acme.c', 'acme.a', 'acme.b'])
  })

  it('marks disabled extensions and never disables a mandatory one', () => {
    const registry = new ExtensionRegistry()
    registry.register(manifest({ id: 'acme.core', mandatory: true }))
    registry.register(manifest({ id: 'acme.extra' }))
    const views = registry.list(['acme.core', 'acme.extra'])
    expect(views.find((v) => v.id === 'acme.core')?.enabled).toBe(true)
    expect(views.find((v) => v.id === 'acme.extra')?.enabled).toBe(false)
  })

  it('unregisters by id', () => {
    const registry = new ExtensionRegistry()
    registry.register(manifest())
    expect(registry.unregister('acme.demo')).toBe(true)
    expect(registry.unregister('acme.demo')).toBe(false)
    expect(registry.size).toBe(0)
  })
})
