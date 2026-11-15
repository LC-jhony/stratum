/** Declarative extension surface shared by the main process and the renderer. */

/** What an extension contributes. `core` ships the workbench itself. */
export type ExtensionKind = 'core' | 'plugin' | 'driver' | 'theme' | 'language'

/** A command an extension advertises. Later phases dispatch these through the palette/router. */
export interface ExtensionCommand {
  id: string
  title: string
}

/**
 * Manifest understood by the registry. It is intentionally data-only: loading third-party code is
 * a later concern, while the registry, conflict rules and UI can be exercised today.
 */
export interface ExtensionManifest {
  /** Stable, namespaced id (`publisher.name`); unique across installed extensions. */
  id: string
  name: string
  /** Semantic version of the extension, independent from the application version. */
  version: string
  description: string
  author?: string
  kind: ExtensionKind
  /** Higher priority wins when two manifests claim the same id; also sorts the installed list. */
  priority: number
  /** Ships with the application bundle. */
  builtin: boolean
  /** Core infrastructure that cannot be disabled from the UI. */
  mandatory?: boolean
  commands?: ExtensionCommand[]
  /** Connection kinds this extension provides support for. */
  drivers?: string[]
}

/** A manifest plus the state derived from user settings, ready for the Extensions dialog. */
export interface ExtensionView extends ExtensionManifest {
  enabled: boolean
}
