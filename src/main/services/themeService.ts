import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseJsonc } from 'jsonc-parser'
import type { ThemeFile, ThemeManifestEntry } from '../../shared/types'

const MAX_THEME_BYTES = 16 * 1024 * 1024
const MAX_INCLUDE_DEPTH = 8
const JSON_CACHE_LIMIT = 128

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const ASSOCIATIONS = [
  'file', 'folder', 'folderExpanded', 'rootFolder', 'rootFolderExpanded',
  'fileExtensions', 'fileNames', 'folderNames', 'folderNamesExpanded', 'languageIds',
] as const

/**
 * Decides what a theme JSON actually is. `fonts` alone cannot mean "product icons": font-based
 * file icon themes carry fonts too. The association keys are the reliable discriminator, then the
 * file name, then the definition shape.
 */
export function classifyTheme(json: unknown, filename: string): ThemeManifestEntry['kind'] {
  if (!isRecord(json) || !isRecord(json.iconDefinitions)) return 'color'
  if (ASSOCIATIONS.some((key) => key in json)) return 'fileIcon'
  if (/file.?icon/i.test(filename)) return 'fileIcon'
  if (/product/i.test(filename)) return 'productIcon'
  const definitions = Object.values(json.iconDefinitions)
  return definitions.some((def) => isRecord(def) && typeof def.fontCharacter === 'string')
    ? 'productIcon'
    : 'fileIcon'
}

/**
 * Drops fields with the wrong shape before the renderer sees them. A malformed third-party theme
 * must degrade to the built-in defaults, not throw inside `resolveColors` or the icon resolver.
 */
export function normalizeTheme(json: unknown): Record<string, unknown> {
  if (!isRecord(json)) return {}
  const out = { ...json }
  if ('colors' in out) {
    out.colors = isRecord(out.colors)
      ? Object.fromEntries(Object.entries(out.colors).filter(([, value]) => typeof value === 'string'))
      : undefined
    if (out.colors === undefined) delete out.colors
  }
  if ('tokenColors' in out && !Array.isArray(out.tokenColors)) delete out.tokenColors
  if ('semanticTokenColors' in out && !isRecord(out.semanticTokenColors)) delete out.semanticTokenColors
  if ('iconDefinitions' in out && !isRecord(out.iconDefinitions)) delete out.iconDefinitions
  if ('fonts' in out && !Array.isArray(out.fonts)) delete out.fonts
  return out
}

const mergeTheme = (base: Record<string, unknown>, own: Record<string, unknown>): Record<string, unknown> => {
  const out = { ...base, ...own }
  if (isRecord(base.colors) || isRecord(own.colors)) {
    out.colors = {
      ...(isRecord(base.colors) ? base.colors : {}),
      ...(isRecord(own.colors) ? own.colors : {}),
    }
  }
  if (Array.isArray(base.tokenColors) || Array.isArray(own.tokenColors)) {
    out.tokenColors = [
      ...(Array.isArray(base.tokenColors) ? base.tokenColors : []),
      ...(Array.isArray(own.tokenColors) ? own.tokenColors : []),
    ]
  }
  if (isRecord(base.semanticTokenColors) || isRecord(own.semanticTokenColors)) {
    out.semanticTokenColors = {
      ...(isRecord(base.semanticTokenColors) ? base.semanticTokenColors : {}),
      ...(isRecord(own.semanticTokenColors) ? own.semanticTokenColors : {}),
    }
  }
  return out
}

const extensionRoots = (): string[] => ['.vscode/extensions', '.vscode-oss/extensions', '.vscode-insiders/extensions', '.cursor/extensions']
  .map((root) => path.join(os.homedir(), root))

interface CachedJson {
  mtimeMs: number
  size: number
  value: unknown
}

interface ThemeContribution {
  id?: string
  label?: string
  path: string
  uiTheme?: ThemeManifestEntry['uiTheme']
}

interface ExtensionPackage {
  contributes?: {
    themes?: ThemeContribution[]
    iconThemes?: ThemeContribution[]
    productIconThemes?: ThemeContribution[]
  }
}

export class ThemeService {
  /** Roots the stratum-asset:// protocol may serve from (themes and their icon files only). */
  readonly allowedRoots = new Set<string>()
  /**
   * Parsed JSON keyed by absolute path and validated against mtime + size. Switching back to a
   * theme reuses its 455 kB icon JSON instead of reading and parsing it again. `list()` and
   * `read()` share this cache, so applying a theme no longer rescans the whole catalog.
   */
  private readonly jsonCache = new Map<string, CachedJson>()
  /** Catalog entries by absolute path, including extension contributions. */
  private readonly entryByPath = new Map<string, ThemeManifestEntry>()

  constructor(private builtinDir: string, private userDir: string) {
    this.allowedRoots.add(path.resolve(builtinDir))
    this.allowedRoots.add(path.resolve(userDir))
  }

  private inside(file: string, root: string): boolean {
    return file === root || file.startsWith(root + path.sep)
  }

  private isAllowed(file: string): boolean {
    return [...this.allowedRoots].some((root) => this.inside(file, root))
  }

  private async readJson(file: string): Promise<unknown> {
    const abs = path.resolve(file)
    const stat = await fs.stat(abs).catch(() => undefined)
    if (!stat?.isFile()) throw new Error(`Theme file not found: ${path.basename(abs)}`)
    if (stat.size > MAX_THEME_BYTES) throw new Error(`Theme file is too large: ${path.basename(abs)}`)
    const hit = this.jsonCache.get(abs)
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      // Refresh insertion order so the small cache behaves like an LRU.
      this.jsonCache.delete(abs)
      this.jsonCache.set(abs, hit)
      return hit.value
    }
    const value = parseJsonc(await fs.readFile(abs, 'utf8'), [], { allowTrailingComma: true })
    this.jsonCache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, value })
    if (this.jsonCache.size > JSON_CACHE_LIMIT) {
      for (const key of this.jsonCache.keys()) {
        if (this.jsonCache.size <= JSON_CACHE_LIMIT) break
        this.jsonCache.delete(key)
      }
    }
    return value
  }

  private entryFor(abs: string, source: ThemeManifestEntry['source'], json: unknown): ThemeManifestEntry {
    const name = isRecord(json) && typeof json.name === 'string' ? json.name.slice(0, 200) : ''
    const type = isRecord(json) ? json.type : undefined
    const uiTheme = type === 'light' ? 'vs' : type === 'hcLight' ? 'hc-light' : type === 'hc' ? 'hc-black' : 'vs-dark'
    const entry: ThemeManifestEntry = {
      id: `${source}:${path.basename(abs)}`,
      label: name || path.basename(abs).replace(/\.json$/, ''),
      kind: classifyTheme(json, path.basename(abs)),
      uiTheme,
      path: abs,
      source,
    }
    this.entryByPath.set(abs, entry)
    return entry
  }

  async list(): Promise<ThemeManifestEntry[]> {
    const out: ThemeManifestEntry[] = []
    for (const [dir, source] of [[this.builtinDir, 'builtin'], [this.userDir, 'user']] as const) {
      for (const file of (await fs.readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.json')).sort()) {
        const abs = path.join(dir, file)
        try {
          out.push(this.entryFor(abs, source, await this.readJson(abs)))
        } catch { /* skip unreadable theme */ }
      }
    }
    return out
  }

  /** Themes contributed by installed VS Code / VSCodium / Cursor extensions. */
  async importVsCodeExtensions(roots: readonly string[] = extensionRoots()): Promise<ThemeManifestEntry[]> {
    const found = new Map<string, ThemeManifestEntry>()
    for (const root of roots) {
      for (const ext of await fs.readdir(root).catch(() => [] as string[])) {
        const dir = path.join(root, ext)
        const pkg = (await this.readJson(path.join(dir, 'package.json')).catch(() => undefined)) as ExtensionPackage | undefined
        if (!pkg?.contributes) continue
        this.allowedRoots.add(path.resolve(dir))
        const add = (list: ThemeContribution[] | undefined, kind: ThemeManifestEntry['kind']) => {
          for (const [index, theme] of (list ?? []).entries()) {
            const abs = path.resolve(dir, theme.path)
            const entry: ThemeManifestEntry = {
              id: `ext:${ext}:${theme.id ?? theme.label ?? index}:${kind}`,
              label: (theme.label ?? theme.id ?? ext).slice(0, 200),
              kind,
              uiTheme: theme.uiTheme,
              path: abs,
              source: 'vscode-extension',
            }
            this.entryByPath.set(abs, entry)
            found.set(entry.id, entry)
          }
        }
        add(pkg.contributes.themes, 'color')
        add(pkg.contributes.iconThemes, 'fileIcon')
        add(pkg.contributes.productIconThemes, 'productIcon')
      }
    }
    return [...found.values()]
  }

  /** Reads a theme and inlines `include` chains (VS Code themes commonly extend a base theme). */
  async read(file: string): Promise<ThemeFile> {
    const abs = path.resolve(file)
    if (!this.isAllowed(abs)) throw new Error('Theme path is outside allowed folders')
    const json = await this.resolveIncludes(abs, 0, new Set([abs]))
    const normalized = normalizeTheme(json)
    const source: ThemeManifestEntry['source'] = this.inside(abs, path.resolve(this.userDir))
      ? 'user'
      : this.inside(abs, path.resolve(this.builtinDir)) ? 'builtin' : 'vscode-extension'
    const known = this.entryByPath.get(abs)
    // An extension declares what its theme is; re-deriving the kind from the JSON could turn a
    // font-based file-icon theme with no associations into a product-icon theme. Local files are
    // reclassified because their content may have been replaced since the catalog was listed.
    const entry = known && known.source === 'vscode-extension'
      ? { ...known }
      : known
        ? { ...known, kind: classifyTheme(normalized, path.basename(abs)) }
        : this.entryFor(abs, source, normalized)
    // `readJson` keeps every file of the include chain cached by mtime, so switching back to this
    // theme parses nothing again while an edited base theme still invalidates the chain.
    return { entry, json: normalized, baseUrl: `stratum-asset://local${pathToFileURL(path.dirname(abs)).pathname}/` }
  }

  private async resolveIncludes(file: string, depth: number, seen: Set<string>): Promise<unknown> {
    if (depth > MAX_INCLUDE_DEPTH) throw new Error('Theme include chain is too deep')
    const parsed = await this.readJson(file)
    if (!isRecord(parsed) || typeof parsed.include !== 'string') return parsed
    const next = path.resolve(path.dirname(file), parsed.include)
    // An include is data from the theme, not a trusted path: it may only read inside the folders
    // Stratum already exposes to the asset protocol.
    if (!this.isAllowed(next)) throw new Error('Theme include points outside the allowed theme folders')
    if (seen.has(next)) throw new Error('Theme include cycle')
    const base = await this.resolveIncludes(next, depth + 1, new Set([...seen, next]))
    return mergeTheme(isRecord(base) ? base : {}, parsed)
  }

  static async fileExists(p: string) { return fs.access(p).then(() => true, () => false) }
}
