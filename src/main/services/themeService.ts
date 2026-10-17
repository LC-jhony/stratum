import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseJsonc } from 'jsonc-parser'
import type { ThemeFile, ThemeManifestEntry } from '../../shared/types'

const readJsonc = async (file: string) => parseJsonc(await fs.readFile(file, 'utf8'), [], { allowTrailingComma: true })
const exists = (p: string) => fs.access(p).then(() => true, () => false)

export class ThemeService {
  /** Roots the stratum-asset:// protocol may serve from (themes and their icon files only). */
  readonly allowedRoots = new Set<string>()
  constructor(private builtinDir: string, private userDir: string) {
    this.allowedRoots.add(path.resolve(builtinDir)); this.allowedRoots.add(path.resolve(userDir))
  }

  async list(): Promise<ThemeManifestEntry[]> {
    const out: ThemeManifestEntry[] = []
    for (const [dir, source] of [[this.builtinDir, 'builtin'], [this.userDir, 'user']] as const) {
      for (const f of (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.json'))) {
        const p = path.join(dir, f)
        try {
          const j = (await readJsonc(p)) as { name?: string; type?: string; iconDefinitions?: unknown; fonts?: unknown }
          const kind = j.iconDefinitions ? (j.fonts || /product/i.test(f) ? 'productIcon' : 'fileIcon') : 'color'
          const uiTheme = j.type === 'light' ? 'vs' : j.type === 'hcLight' ? 'hc-light' : j.type === 'hc' ? 'hc-black' : 'vs-dark'
          out.push({ id: `${source}:${f}`, label: j.name ?? f.replace(/\.json$/, ''), kind, uiTheme, path: p, source })
        } catch { /* skip unreadable theme */ }
      }
    }
    return out
  }

  /** Themes contributed by installed VS Code / VSCodium / Cursor extensions. */
  async importVsCodeExtensions(): Promise<ThemeManifestEntry[]> {
    const roots = ['.vscode/extensions', '.vscode-oss/extensions', '.vscode-insiders/extensions', '.cursor/extensions'].map((r) => path.join(os.homedir(), r))
    const out: ThemeManifestEntry[] = []
    for (const root of roots) {
      for (const ext of await fs.readdir(root).catch(() => [] as string[])) {
        const dir = path.join(root, ext)
        const pkg = (await readJsonc(path.join(dir, 'package.json')).catch(() => undefined)) as { contributes?: Record<string, { id?: string; label?: string; path: string; uiTheme?: ThemeManifestEntry['uiTheme'] }[]> } | undefined
        if (!pkg?.contributes) continue
        const add = (list: typeof pkg.contributes[string] | undefined, kind: ThemeManifestEntry['kind']) => {
          for (const t of list ?? []) { this.allowedRoots.add(path.resolve(dir)); out.push({ id: `ext:${ext}:${t.id ?? t.label}:${kind}`, label: t.label ?? t.id ?? ext, kind, uiTheme: t.uiTheme, path: path.resolve(dir, t.path), source: 'vscode-extension' }) }
        }
        add(pkg.contributes.themes, 'color'); add(pkg.contributes.iconThemes, 'fileIcon'); add(pkg.contributes.productIconThemes, 'productIcon')
      }
    }
    return out
  }

  /** Reads a theme and inlines `include` chains (VS Code themes commonly extend a base theme). */
  async read(file: string): Promise<ThemeFile> {
    const abs = path.resolve(file)
    if (![...this.allowedRoots].some((r) => abs.startsWith(r + path.sep))) throw new Error('Theme path is outside allowed folders')
    const json = await this.resolveIncludes(abs, 0) as Record<string, unknown>
    const dir = path.dirname(abs)
    const entry = (await this.list()).find((e) => e.path === abs) ?? { id: abs, label: String(json.name ?? path.basename(abs)), kind: 'color' as const, path: abs, source: 'user' as const }
    return { entry, json, baseUrl: `stratum-asset://local${pathToFileURL(dir).pathname}/` }
  }

  private async resolveIncludes(file: string, depth: number): Promise<unknown> {
    const j = (await readJsonc(file)) as Record<string, any>
    if (!j.include || depth > 4) return j
    const base = (await this.resolveIncludes(path.resolve(path.dirname(file), j.include), depth + 1)) as Record<string, any>
    return { ...base, ...j, colors: { ...base.colors, ...j.colors }, tokenColors: [...(base.tokenColors ?? []), ...(j.tokenColors ?? [])], semanticTokenColors: { ...base.semanticTokenColors, ...j.semanticTokenColors } }
  }
  static async fileExists(p: string) { return exists(p) }
}
