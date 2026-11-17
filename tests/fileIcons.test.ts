import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assetUrl,
  cssUrl,
  decodeFontCharacter,
  fileIconFontCss,
  pickIconId,
  resolveFileIcon,
  resolveFileIconById,
  type FileIconThemeJson,
} from '../src/renderer/src/theme/fileIconTheme'

const THEMES = ['dawn', 'deep', 'dim', 'you'] as const
const root = path.resolve('themes')
const load = (id: string) => JSON.parse(readFileSync(path.join(root, `${id}.json`), 'utf8')) as FileIconThemeJson & Record<string, unknown>

describe('bundled file icon themes', () => {
  it('ships the four Valet themes with their display names', () => {
    for (const id of THEMES) {
      const t = load(id)
      expect(t.name).toMatch(/^(Dawn|Deep|Dim|You)$/)
      expect(t.iconDefinitions.table).toBeTruthy()
      expect(t.iconDefinitions.database).toBeTruthy()
    }
  })

  it('keeps every icon definition pointing at an SVG that exists', () => {
    for (const id of THEMES) {
      for (const [name, def] of Object.entries(load(id).iconDefinitions)) {
        if (!def.iconPath) continue
        const file = path.join(root, def.iconPath.replace(/^\.\//, ''))
        expect(existsSync(file), `${id}: ${name} → ${def.iconPath}`).toBe(true)
      }
    }
  })

  it('never leaves an association pointing at a pruned definition', () => {
    for (const id of THEMES) {
      const t = load(id)
      const sections = [t, (t.light ?? {}) as Record<string, unknown>]
      for (const section of sections) {
        for (const key of ['fileExtensions', 'fileNames', 'folderNames', 'folderNamesExpanded', 'languageIds']) {
          for (const [name, target] of Object.entries((section[key] as Record<string, string>) ?? {})) {
            expect(t.iconDefinitions[target], `${id}/${key}/${name} → ${target}`).toBeTruthy()
          }
        }
      }
    }
  })

  it('stays small: the pruned set is a handful of ids, not the 952-icon source', () => {
    for (const id of THEMES) expect(Object.keys(load(id).iconDefinitions).length).toBeLessThanOrEqual(40)
  })
})

describe('resolveFileIconById', () => {
  const theme: FileIconThemeJson = {
    iconDefinitions: {
      table: { iconPath: './dark/table.svg' },
      __table: { iconPath: './light/table.svg' },
      only: { iconPath: './dark/only.svg' },
    },
  }

  it('resolves an explicit id against the theme base URL', () => {
    expect(resolveFileIconById(theme, 'stratum-asset://local/root/', 'table')).toEqual({ kind: 'image', url: 'stratum-asset://local/root/dark/table.svg' })
  })

  it('prefers the light twin when the mode is light', () => {
    expect(resolveFileIconById(theme, 'stratum-asset://local/root/', 'table', true)).toMatchObject({ url: 'stratum-asset://local/root/light/table.svg' })
    // A theme with a single flavour still resolves, and an already-prefixed id is not prefixed twice.
    expect(resolveFileIconById(theme, 'stratum-asset://local/root/', 'only', true)).toMatchObject({ url: 'stratum-asset://local/root/dark/only.svg' })
    expect(resolveFileIconById(theme, 'stratum-asset://local/root/', '__table', true)).toMatchObject({ url: 'stratum-asset://local/root/light/table.svg' })
  })

  it('returns undefined for unknown ids so the caller can fall back', () => {
    expect(resolveFileIconById(theme, 'stratum-asset://local/root/', 'missing')).toBeUndefined()
    expect(resolveFileIconById(undefined, 'stratum-asset://local/root/', 'table')).toBeUndefined()
  })
})

describe('pruned associations', () => {
  it('still maps extensions, names and folders to the kept ids', () => {
    const t = load('dawn')
    // The pruned set has no `sql` association; SQL files fall back to the theme's default file icon.
    expect(pickIconId(t, 'table.sql', 'file', false)).toBe('file')
    expect(pickIconId(t, 'data.csv', 'file', false)).toBe('csv')
    expect(pickIconId(t, 'package.json', 'file', false)).toBe('json')
    expect(pickIconId(t, 'database', 'folder', false)).toBe('folder_database')
    expect(pickIconId(t, 'src', 'folder', false)).toBe('folder_gray')
    expect(pickIconId(t, 'src', 'folderExpanded', false)).toBe('folder_gray_open')
  })

  it('uses the light twins through resolveFileIcon', () => {
    const t = load('dim')
    expect(resolveFileIcon(t, 'stratum-asset://local/root/', 'database', 'folder', true)).toMatchObject({ url: expect.stringContaining('/dim-light/') })
  })
})

describe('font-based icon themes', () => {
  const theme: FileIconThemeJson = {
    iconDefinitions: {
      file: { fontCharacter: '\\e001', fontColor: '#f00', fontId: 'icons' },
      alert: { fontCharacter: '\\ea60', fontId: 'icons' },
    },
    fonts: [{ id: 'icons', src: [{ path: './icons.woff2', format: 'woff2' }] }],
    file: 'file',
  }

  it('decodes CSS escapes instead of asking JSON to parse them', () => {
    expect(decodeFontCharacter('\\e001')).toBe(String.fromCodePoint(0xe001))
    expect(decodeFontCharacter('\\ea60')).toBe(String.fromCodePoint(0xea60))
    expect(decodeFontCharacter('\\1f600')).toBe('😀')
    expect(decodeFontCharacter('\\e001 rest')).toBe(`${String.fromCodePoint(0xe001)}rest`)
    expect(decodeFontCharacter('plain')).toBe('plain')
    expect(decodeFontCharacter('\\\\')).toBe('\\')
  })

  it('resolves a glyph with its font family', () => {
    expect(resolveFileIcon(theme, 'stratum-asset://local/root/', 'x', 'file')).toEqual({
      kind: 'glyph',
      char: '\\e001',
      color: '#f00',
      fontFamily: 'stratum-fi-icons',
    })
  })

  it('keeps only asset URLs and escapes quotes in CSS', () => {
    expect(assetUrl('stratum-asset://local/root/', 'icons.woff2')).toBe('stratum-asset://local/root/icons.woff2')
    expect(assetUrl('stratum-asset://local/root/', 'https://evil.test/x.svg')).toBeUndefined()
    expect(assetUrl('stratum-asset://local/root/', 'file:///etc/passwd')).toBeUndefined()
    expect(assetUrl('stratum-asset://local/root/', 'bad\npath')).toBe('stratum-asset://local/root/badpath')
    expect(cssUrl("stratum-asset://local/root/a'b.svg")).toBe('stratum-asset://local/root/a%27b.svg')
    const css = fileIconFontCss({
      iconDefinitions: {},
      fonts: [{ id: "bad'id", src: [{ path: './ok.woff', format: 'woff' }, { path: 'https://evil.test/x.woff', format: 'woff' }] }],
    }, 'stratum-asset://local/root/')
    expect(css).toContain("font-family:'stratum-fi-badid'")
    expect(css).toContain("url('stratum-asset://local/root/ok.woff')")
    expect(css).not.toContain('evil.test')
  })
})

describe('icon resolution cache and safety', () => {
  const theme: FileIconThemeJson = {
    iconDefinitions: { table: { iconPath: './table.svg' }, broken: { iconPath: 'https://evil.test/x.svg' } },
  }

  it('returns the identical resolved object for repeated lookups', () => {
    const first = resolveFileIconById(theme, 'stratum-asset://local/root/', 'table')
    const second = resolveFileIconById(theme, 'stratum-asset://local/root/', 'table')
    expect(second).toBe(first)
    expect(resolveFileIcon(theme, 'stratum-asset://local/root/', 'x.table', 'file'))
      .toBe(resolveFileIcon(theme, 'stratum-asset://local/root/', 'x.table', 'file'))
  })

  it('falls back instead of throwing on an external or malformed path', () => {
    expect(resolveFileIconById(theme, 'stratum-asset://local/root/', 'broken')).toBeUndefined()
    expect(resolveFileIconById({ iconDefinitions: { bad: { iconPath: 'http://[' } } }, 'stratum-asset://local/root/', 'bad')).toBeUndefined()
  })
})
