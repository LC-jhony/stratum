import { ExtensionRegistry } from '../../core/registry'
import type { ExtensionView } from '../../shared/extensions'
import { logger } from '../logger'
import { BUILTIN_EXTENSIONS } from '../extensions/builtin'
import { EXAMPLE_PLUGIN } from '../plugins/builtin/example'
import type { SettingsService } from './settingsService'

/**
 * Owns the installed manifests and the persisted enable/disable list. Disabling is advisory for the
 * UI and future plugin loading; mandatory core extensions can never be turned off.
 */
export class ExtensionService {
  private readonly registry = new ExtensionRegistry()

  constructor(private readonly settings: SettingsService) {
    for (const manifest of [...BUILTIN_EXTENSIONS, EXAMPLE_PLUGIN]) {
      try { this.registry.register(manifest) }
      catch (e) { logger.error('[extensions] skipped an invalid manifest', manifest.id, e) }
    }
  }

  async list(): Promise<ExtensionView[]> {
    const disabled = (await this.settings.get())['extensions.disabled']
    return this.registry.list(disabled)
  }

  async setEnabled(id: string, enabled: boolean): Promise<ExtensionView[]> {
    const manifest = this.registry.get(id)
    if (!manifest) throw new Error(`Unknown extension: ${id}`)
    if (!enabled && manifest.mandatory) throw new Error(`${manifest.name} is required and cannot be disabled`)
    const disabled = (await this.settings.get())['extensions.disabled']
    const next = enabled ? disabled.filter((x) => x !== id) : [...disabled.filter((x) => x !== id), id]
    await this.settings.update({ 'extensions.disabled': next })
    return this.list()
  }
}
