import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pickIconId, resolveFileIcon, resolveFileIconById, type FileIconThemeJson } from '../src/renderer/src/theme/fileIconTheme'

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
