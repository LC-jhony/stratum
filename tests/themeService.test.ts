import { mkdtemp, mkdir, rm, truncate, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ThemeService, classifyTheme, normalizeTheme } from '../src/main/services/themeService'

const roots: string[] = []
const temp = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stratum-theme-'))
  roots.push(dir)
  return dir
}
const write = async (file: string, value: unknown) => {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value), 'utf8')
}
const serviceAt = async () => {
  const root = await temp()
  const builtin = path.join(root, 'builtin')
  const user = path.join(root, 'user')
  await mkdir(builtin, { recursive: true })
  await mkdir(user, { recursive: true })
  return { root, builtin, user, service: new ThemeService(builtin, user) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('theme classification', () => {
  it('uses associations before the font heuristic', () => {
    const fontFileIcons = { iconDefinitions: { f: { fontCharacter: '\\e001' } }, fonts: [{ id: 'f', src: [] }], file: 'f', fileExtensions: { sql: 'f' } }
    expect(classifyTheme(fontFileIcons, 'dawn.json')).toBe('fileIcon')
    expect(classifyTheme({ iconDefinitions: { db: { fontCharacter: '\\e900' } }, fonts: [{ id: 'f', src: [] }] }, 'product.json')).toBe('productIcon')
    expect(classifyTheme({ iconDefinitions: { file: { iconPath: './f.svg' } }, file: 'file' }, 'anything.json')).toBe('fileIcon')
    expect(classifyTheme({ colors: {} }, 'carbon.json')).toBe('color')
    expect(classifyTheme(null, 'broken.json')).toBe('color')
  })

  it('normalizes malformed fields instead of handing them to the renderer', () => {
    expect(normalizeTheme({ colors: { ok: '#fff', bad: 3 }, tokenColors: 'nope', iconDefinitions: [] })).toEqual({ colors: { ok: '#fff' } })
    expect(normalizeTheme([])).toEqual({})
    expect(normalizeTheme(null)).toEqual({})
  })
})

describe('theme catalog', () => {
  it('lists built-in and user themes with their real kind and uiTheme', async () => {
    const { builtin, user, service } = await serviceAt()
    await write(path.join(builtin, 'carbon-dark.json'), { name: 'Carbon Dark', type: 'dark', colors: {} })
    await write(path.join(builtin, 'dawn.json'), { name: 'Dawn', iconDefinitions: { f: { fontCharacter: '\\e001' } }, fonts: [{ id: 'f', src: [] }], file: 'f' })
    await write(path.join(user, 'min-light.json'), { name: 'Min Light', type: 'light', colors: {} })
    const list = await service.list()
    expect(list.map((entry) => [entry.id, entry.label, entry.kind, entry.uiTheme])).toEqual([
      ['builtin:carbon-dark.json', 'Carbon Dark', 'color', 'vs-dark'],
      ['builtin:dawn.json', 'Dawn', 'fileIcon', 'vs-dark'],
      ['user:min-light.json', 'Min Light', 'color', 'vs'],
    ])
  })

  it('keeps an extension theme id when it is read back', async () => {
    const { root, service } = await serviceAt()
    const ext = path.join(root, 'extensions', 'acme.icons')
    await write(path.join(ext, 'package.json'), { contributes: { iconThemes: [{ id: 'acme-dawn', label: 'Acme Dawn', path: './icons.json' }] } })
    await write(path.join(ext, 'icons.json'), { name: 'Acme Dawn', iconDefinitions: { file: { iconPath: './file.svg' } }, file: 'file' })
    const [entry] = await service.importVsCodeExtensions([path.join(root, 'extensions')])
    expect(entry.kind).toBe('fileIcon')
    expect(entry.id).toMatch(/^ext:acme\.icons:acme-dawn:fileIcon$/)
    const file = await service.read(entry.path)
    expect(file.entry.id).toBe(entry.id)
    expect(file.entry.kind).toBe('fileIcon')
    expect(file.entry.label).toBe('Acme Dawn')
  })

  it('trusts the kind an extension declares even without associations', async () => {
    const { root, service } = await serviceAt()
    const ext = path.join(root, 'extensions', 'acme.fonticons')
    await write(path.join(ext, 'package.json'), { contributes: { iconThemes: [{ id: 'acme-font', label: 'Acme Font', path: './icons.json' }] } })
    // A font-based file icon theme whose definitions are only glyphs: shape alone would read as a
    // product icon theme, but the extension contribution is authoritative.
    await write(path.join(ext, 'icons.json'), { iconDefinitions: { file: { fontCharacter: '\\e001' } }, fonts: [{ id: 'f', src: [{ path: './f.woff2', format: 'woff2' }] }] })
    const [entry] = await service.importVsCodeExtensions([path.join(root, 'extensions')])
    expect(entry.kind).toBe('fileIcon')
    expect((await service.read(entry.path)).entry.kind).toBe('fileIcon')
  })
})

describe('theme includes', () => {
  it('merges colors and token rules and re-reads an edited base', async () => {
    const { builtin, service } = await serviceAt()
    await write(path.join(builtin, 'base.json'), { name: 'Base', colors: { 'editor.background': '#111111' }, tokenColors: [{ scope: 'comment' }] })
    await write(path.join(builtin, 'child.json'), { name: 'Child', include: './base.json', colors: { 'editor.foreground': '#EEEEEE' }, tokenColors: [{ scope: 'keyword' }] })
    const first = await service.read(path.join(builtin, 'child.json')) as { entry: { id: string }; json: { colors: Record<string, string>; tokenColors: unknown[] } }
    expect(first.entry.id).toBe('builtin:child.json')
    expect(first.json.colors).toEqual({ 'editor.background': '#111111', 'editor.foreground': '#EEEEEE' })
    expect(first.json.tokenColors).toHaveLength(2)

    await new Promise((resolve) => setTimeout(resolve, 15))
    await write(path.join(builtin, 'base.json'), { name: 'Base', colors: { 'editor.background': '#222222' } })
    const second = await service.read(path.join(builtin, 'child.json')) as { json: { colors: Record<string, string> } }
    expect(second.json.colors['editor.background']).toBe('#222222')
  })

  it('rejects an include outside the allowed folders', async () => {
    const { root, builtin, service } = await serviceAt()
    await write(path.join(root, 'outside.json'), { colors: { 'editor.background': '#000000' } })
    await write(path.join(builtin, 'escape.json'), { include: '../outside.json' })
    await expect(service.read(path.join(builtin, 'escape.json'))).rejects.toThrow(/outside the allowed/)
  })

  it('rejects an include cycle', async () => {
    const { builtin, service } = await serviceAt()
    await write(path.join(builtin, 'a.json'), { include: './b.json' })
    await write(path.join(builtin, 'b.json'), { include: './a.json' })
    await expect(service.read(path.join(builtin, 'a.json'))).rejects.toThrow(/cycle/)
  })

  it('refuses a theme file above the size cap', async () => {
    const { builtin, service } = await serviceAt()
    const file = path.join(builtin, 'huge.json')
    await write(file, {})
    await truncate(file, 17 * 1024 * 1024)
    await expect(service.read(file)).rejects.toThrow(/too large/)
  })
})
