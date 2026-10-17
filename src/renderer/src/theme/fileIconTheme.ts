/** VS Code file icon theme: https://code.visualstudio.com/api/extension-guides/file-icon-theme */
interface IconDefinition { iconPath?: string; fontCharacter?: string; fontColor?: string; fontId?: string; fontSize?: string }
interface Associations {
  file?: string; folder?: string; folderExpanded?: string; rootFolder?: string; rootFolderExpanded?: string
  fileExtensions?: Record<string, string>; fileNames?: Record<string, string>
  folderNames?: Record<string, string>; folderNamesExpanded?: Record<string, string>; languageIds?: Record<string, string>
}
export interface FileIconThemeJson extends Associations {
  iconDefinitions: Record<string, IconDefinition>
  fonts?: { id: string; src: { path: string; format: string }[]; weight?: string; style?: string; size?: string }[]
  light?: Associations; highContrast?: Associations
}
export type ResolvedIcon = { kind: 'image'; url: string } | { kind: 'glyph'; char: string; color?: string; fontFamily: string } | undefined

const EXT_LANG: Record<string, string> = { sql: 'sql', json: 'json', md: 'markdown', ts: 'typescript', js: 'javascript', py: 'python', csv: 'csv', xml: 'xml', yml: 'yaml', yaml: 'yaml' }

export function pickIconId(t: FileIconThemeJson, name: string, kind: 'file' | 'folder' | 'folderExpanded' | 'root', lightMode: boolean): string | undefined {
  const sets: Associations[] = lightMode && t.light ? [t.light, t] : [t]
  const lower = name.toLowerCase()
  for (const a of sets) {
    if (kind === 'file') {
      if (a.fileNames?.[lower]) return a.fileNames[lower]
      // `a.b.c` tries "b.c" then "c" (longest suffix wins), exactly like VS Code.
      for (let i = lower.indexOf('.'); i >= 0; i = lower.indexOf('.', i + 1)) { const ext = lower.slice(i + 1); if (ext && a.fileExtensions?.[ext]) return a.fileExtensions[ext] }
      const lang = EXT_LANG[lower.split('.').pop() ?? '']
      if (lang && a.languageIds?.[lang]) return a.languageIds[lang]
    } else if (kind === 'folderExpanded') {
      const id = a.folderNamesExpanded?.[lower] ?? a.folderNames?.[lower]; if (id) return id
    } else if (kind === 'folder') {
      const id = a.folderNames?.[lower]; if (id) return id
    }
  }
  const base = sets[0], root = t
  const dflt = kind === 'file' ? base.file ?? root.file : kind === 'folder' ? base.folder ?? root.folder : kind === 'folderExpanded' ? base.folderExpanded ?? root.folderExpanded ?? base.folder ?? root.folder : base.rootFolder ?? root.rootFolder ?? root.folder
  return dflt
}

export function resolveFileIcon(t: FileIconThemeJson | undefined, baseUrl: string, name: string, kind: 'file' | 'folder' | 'folderExpanded' | 'root', lightMode = false): ResolvedIcon {
  if (!t) return undefined
  const id = pickIconId(t, name, kind, lightMode)
  const def = id ? t.iconDefinitions[id] : undefined
  if (!def) return undefined
  if (def.iconPath) return { kind: 'image', url: new URL(def.iconPath, baseUrl).href }
  if (def.fontCharacter) return { kind: 'glyph', char: def.fontCharacter, color: def.fontColor, fontFamily: `stratum-fi-${def.fontId ?? t.fonts?.[0]?.id ?? 'default'}` }
  return undefined
}

export function fileIconFontCss(t: FileIconThemeJson, baseUrl: string): string {
  return (t.fonts ?? []).map((f) => `@font-face{font-family:'stratum-fi-${f.id}';src:${f.src.map((s) => `url('${new URL(s.path, baseUrl).href}') format('${s.format}')`).join(',')};font-weight:${f.weight ?? 'normal'};font-style:${f.style ?? 'normal'}}`).join('\n')
}
