/** Pure extension registry: validation, conflict resolution and deterministic ordering. */
import type { ExtensionKind, ExtensionManifest, ExtensionView } from '../shared/extensions'

const ID = /^[a-z0-9][a-z0-9._-]{0,98}[a-z0-9]$/
const COMMAND_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const KINDS: readonly ExtensionKind[] = ['core', 'plugin', 'driver', 'theme', 'language']

/** Problems found in a manifest, ready to be shown in a log line or a dialog. */
export function validateExtension(m: ExtensionManifest): string[] {
  const errors: string[] = []
  if (!m || typeof m !== 'object') return ['manifest must be an object']
  if (typeof m.id !== 'string' || !ID.test(m.id)) errors.push('id must be 2-100 lowercase characters (a-z, 0-9, dot, dash, underscore)')
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.trim().length > 120) errors.push('name must be 1-120 characters')
  if (typeof m.version !== 'string' || !VERSION.test(m.version)) errors.push('version must be semantic (major.minor.patch)')
  if (typeof m.description !== 'string' || m.description.length > 500) errors.push('description must be at most 500 characters')
  if (m.author !== undefined && (typeof m.author !== 'string' || m.author.length > 200)) errors.push('author must be at most 200 characters')
  if (!KINDS.includes(m.kind)) errors.push(`kind must be one of: ${KINDS.join(', ')}`)
  if (!Number.isInteger(m.priority) || m.priority < 0 || m.priority > 1000) errors.push('priority must be an integer between 0 and 1000')
  if (typeof m.builtin !== 'boolean') errors.push('builtin must be a boolean')
  if (m.mandatory !== undefined && typeof m.mandatory !== 'boolean') errors.push('mandatory must be a boolean')
  if (m.commands !== undefined) {
    if (!Array.isArray(m.commands) || m.commands.length > 100) errors.push('commands must be an array of at most 100 entries')
    else {
      const seen = new Set<string>()
      for (const c of m.commands) {
        if (!c || typeof c.id !== 'string' || !COMMAND_ID.test(c.id)) errors.push('every command needs a valid id')
        else if (seen.has(c.id)) errors.push(`duplicate command id: ${c.id}`)
        else seen.add(c.id)
        if (!c || typeof c.title !== 'string' || !c.title.trim() || c.title.length > 200) errors.push(`command ${c?.id ?? '?'} needs a title of at most 200 characters`)
      }
    }
  }
  if (m.drivers !== undefined) {
    if (!Array.isArray(m.drivers) || m.drivers.length > 50) errors.push('drivers must be an array of at most 50 entries')
    else if (m.drivers.some((d) => typeof d !== 'string' || !d.trim() || d.length > 100)) errors.push('driver names must be 1-100 characters')
    else if (new Set(m.drivers).size !== m.drivers.length) errors.push('driver names must be unique')
  }
  return errors
}

export class InvalidExtensionError extends Error {
  constructor(readonly manifestId: string, readonly problems: string[]) {
    super(`Invalid extension ${manifestId || '(no id)'}: ${problems.join('; ')}`)
    this.name = 'InvalidExtensionError'
  }
}

export class DuplicateExtensionError extends Error {
  constructor(readonly manifestId: string, readonly existingPriority: number, readonly incomingPriority: number) {
    super(`Extension ${manifestId} is already registered with priority ${existingPriority}; priority ${incomingPriority} cannot replace it`)
    this.name = 'DuplicateExtensionError'
  }
}

/**
 * In-memory registry. A duplicate id is only accepted when the newcomer has a strictly higher
 * priority, which makes overlay order explicit instead of depending on load order.
 */
export class ExtensionRegistry {
  private readonly manifests = new Map<string, ExtensionManifest>()

  register(manifest: ExtensionManifest): void {
    const problems = validateExtension(manifest)
    if (problems.length) throw new InvalidExtensionError(manifest?.id ?? '', problems)
    const existing = this.manifests.get(manifest.id)
    if (existing && manifest.priority <= existing.priority) {
      throw new DuplicateExtensionError(manifest.id, existing.priority, manifest.priority)
    }
    this.manifests.set(manifest.id, { ...manifest })
  }

  unregister(id: string): boolean { return this.manifests.delete(id) }
  has(id: string): boolean { return this.manifests.has(id) }
  get(id: string): ExtensionManifest | undefined { return this.manifests.get(id) }
  get size(): number { return this.manifests.size }

  /** Installed manifests, highest priority first, then by name and id for a stable order. */
  list(disabled: readonly string[] = []): ExtensionView[] {
    const off = new Set(disabled)
    return [...this.manifests.values()]
      .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .map((m) => ({ ...m, enabled: m.mandatory ? true : !off.has(m.id) }))
  }
}
