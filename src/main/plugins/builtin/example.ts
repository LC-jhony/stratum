import type { ExtensionManifest } from '../../../shared/extensions'

/**
 * Reference plugin bundled with Stratum. It contributes no runtime code on purpose: it documents
 * the manifest shape (id, priority, commands) that a future downloaded plugin will use, and gives
 * the Extensions dialog a non-driver entry to exercise enable/disable.
 */
export const EXAMPLE_PLUGIN: ExtensionManifest = {
  id: 'stratum.example',
  name: 'Example Plugin',
  version: '0.1.0',
  description: 'Reference extension showing how a plugin declares commands and metadata.',
  author: 'Stratum',
  kind: 'plugin',
  priority: 10,
  builtin: true,
  commands: [{ id: 'example.hello', title: 'Example: Say Hello' }],
}
