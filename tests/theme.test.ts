import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ThemeManifestEntry } from '../src/shared/types'
import { cssVarName, resolveColors, toCssVars } from '../src/renderer/src/theme/colorTheme'
import { contrastRatio, ensureContrast, parseHex, repairContrast } from '../src/renderer/src/theme/contrast'
import { pickIconId, resolveFileIcon } from '../src/renderer/src/theme/fileIconTheme'
import { scopeToToken, toMonacoTheme } from '../src/renderer/src/theme/monacoTheme'
import { hasProductIcon, productIconCss } from '../src/renderer/src/theme/productIconTheme'
import { dedupeCatalog, fileIconFamily, fileIconTheme, kindForMode, paletteOf, paletteTheme, pickThemeEntry, siblingTheme } from '../src/renderer/src/theme/themeManager'

const load = (n: string) => JSON.parse(readFileSync(`themes/${n}.json`, 'utf8'))

describe('Carbon themes (improved)', () => {
  it.each(['carbon-dark', 'carbon-light'])('%s has visible structural borders and table keys', (n) => {
    const c = load(n).colors
    for (const k of ['editorGroup.border', 'sideBar.border', 'panel.border', 'tab.border', 'statusBar.border', 'titleBar.border'])
      expect(c[k].toLowerCase(), k).not.toBe(c['editor.background'].toLowerCase())
    for (const k of ['tree.tableColumnsBorder', 'tree.tableOddRowsBackground', 'charts.blue', 'charts.yellow']) expect(c[k], k).toBeTruthy()
  })
})
describe('color theme engine', () => {
  it('maps keys to VS Code css variable names', () => expect(cssVarName('editor.background')).toBe('--vscode-editor-background'))
  it('fills gaps for a sparse third-party theme', () => {
    const c = resolveColors({ type: 'dark', colors: { 'panel.border': '#123456' } })
    expect(c['tree.tableColumnsBorder']).toBe('#123456')
    expect(c['editor.background']).toBeTruthy()
  })
  it('never leaves a border invisible when the theme defines none', () => expect(resolveColors({ type: 'light', colors: {} })['tree.tableColumnsBorder']).toMatch(/^#/))
  it('gives sparse themes visible scrollbars from the defaults', () => {
    for (const type of ['dark', 'light'] as const) expect(resolveColors({ type, colors: {} })['scrollbarSlider.background'], type).toMatch(/^#/)
  })
  it('derives the inactive activity bar foreground from the active one, like VS Code', () => {
    expect(resolveColors({ type: 'light', colors: { 'activityBar.foreground': '#9e9e9e' } })['activityBar.inactiveForeground']).toBe('#9e9e9e66')
    // Min Light keeps white inactive icons on its light bar if this is not derived.
    expect(resolveColors(load('min-light'))['activityBar.inactiveForeground']).toBe('#8c8c8c66')
    expect(resolveColors(load('min-dark'))['activityBar.inactiveForeground']).toBe('#7D7D7D66')
    expect(resolveColors(load('carbon-dark'))['activityBar.inactiveForeground']).toBe(load('carbon-dark').colors['activityBar.inactiveForeground'])
  })
  it('emits css vars for every resolved key', () => expect(Object.keys(toCssVars(resolveColors(load('carbon-dark')))).length).toBeGreaterThan(250))
})
describe('contrast repair', () => {
  it('computes WCAG contrast and ignores unusable colours', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5)
    expect(contrastRatio('#777777', '#888888')).toBeLessThan(2)
    expect(contrastRatio('not-a-colour', '#FFFFFF')).toBeUndefined()
    expect(parseHex('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 })
    expect(parseHex('#11223380')?.a).toBeCloseTo(0.5, 2)
  })

  it('keeps a pair that already passes untouched', () => {
    expect(ensureContrast('#000000', '#FFFFFF')).toEqual({ fg: '#000000', bg: '#FFFFFF', changed: false })
  })

  it('darkens a filled surface instead of washing out the label', () => {
    const fix = ensureContrast('#FFFFFF', '#FF0000', 4.5, 'bg')
    expect(fix.changed).toBe(true)
    expect(fix.fg).toBe('#FFFFFF')
    expect(fix.bg).not.toBe('#FF0000')
    expect(contrastRatio(fix.fg, fix.bg)!).toBeGreaterThanOrEqual(4.5)
  })

  it('moves text when the surface is the part worth keeping', () => {
    const fix = ensureContrast('#BBBBBB', '#FFFFFF', 4.5, 'fg')
    expect(fix.bg).toBe('#FFFFFF')
    expect(contrastRatio(fix.fg, fix.bg)!).toBeGreaterThanOrEqual(4.5)
  })

  it('leaves translucent colours alone: their real backdrop is unknown', () => {
    expect(ensureContrast('#FFFFFF80', '#000000')).toEqual({ fg: '#FFFFFF80', bg: '#000000', changed: false })
  })

  it('repairs the bundled Carbon button without changing its hue', () => {
    const original = load('carbon-dark').colors
    const fixed = resolveColors(load('carbon-dark'))
    expect(original['button.foreground']).toBe('#FFFFFF')
    expect(fixed['button.background']).not.toBe(original['button.background'])
    expect(contrastRatio(fixed['button.foreground'], fixed['button.background'])!).toBeGreaterThanOrEqual(4.5)
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(fixed['button.background'].slice(i, i + 2), 16))
    expect(r).toBeGreaterThan(g + 80)
    expect(r).toBeGreaterThan(b + 80)
  })

  it('raises the Min status bar and activity bar to their targets', () => {
    for (const name of ['min-light', 'min-dark']) {
      const c = resolveColors(load(name))
      expect(contrastRatio(c['statusBar.foreground'], c['statusBar.background'])!, name).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(c['activityBar.foreground'], c['activityBar.background'])!, name).toBeGreaterThanOrEqual(3)
    }
  })

  it('leaves every bundled chrome pair legible', () => {
    const pairs = [
      ['button.foreground', 'button.background', 4.5],
      ['statusBar.foreground', 'statusBar.background', 4.5],
      ['activityBar.foreground', 'activityBar.background', 3],
      ['sideBar.foreground', 'sideBar.background', 4.5],
      ['menu.foreground', 'menu.background', 4.5],
      ['input.foreground', 'input.background', 4.5],
      ['tab.activeForeground', 'tab.activeBackground', 4.5],
    ] as const
    for (const name of ['carbon-dark', 'carbon-light', 'min-dark', 'min-light']) {
      const c = resolveColors(load(name))
      for (const [fg, bg, target] of pairs) {
        if (parseHex(c[bg])?.a !== 1) continue
        expect(contrastRatio(c[fg], c[bg])!, `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(target)
      }
    }
  })

  it('leaves missing and malformed pairs unchanged', () => {
    expect(repairContrast({ 'button.foreground': '#FFFFFF' })).toEqual({ 'button.foreground': '#FFFFFF' })
    expect(repairContrast({ 'button.foreground': 'white', 'button.background': '#000000' })).toEqual({ 'button.foreground': 'white', 'button.background': '#000000' })
  })
})
describe('theme catalog dedupe', () => {
  const e = (id: string, label: string, source: ThemeManifestEntry['source'], kind: ThemeManifestEntry['kind'] = 'color'): ThemeManifestEntry => ({ id, label, kind, uiTheme: 'vs-dark', path: `/t/${id}`, source })
  it('collapses a VS Code extension copy of a bundled theme', () => {
    const imp = e('ext:carbontheme.carbon-theme-0.0.1:Carbon Dark:color', 'Carbon Dark', 'vscode-extension')
    const { catalog, aliases } = dedupeCatalog([e('builtin:carbon-dark.json', 'Carbon Dark', 'builtin'), imp, e('builtin:min-dark.json', 'Min Dark', 'builtin')])
    expect(catalog.map((x) => x.id)).toEqual(['builtin:carbon-dark.json', 'builtin:min-dark.json'])
    expect(aliases.get(imp.id)).toBe('builtin:carbon-dark.json')
  })
  it('keeps one entry per kind and label, user files over bundled ones', () => {
    const { catalog } = dedupeCatalog([e('builtin:x.json', 'Carbon Dark', 'builtin'), e('user:x.json', 'Carbon Dark', 'user'), e('builtin:y.json', 'Carbon Dark', 'builtin', 'fileIcon')])
    expect(catalog.map((x) => x.id)).toEqual(['user:x.json', 'builtin:y.json'])
  })
})
describe('appearance modes', () => {
  const e = (id: string, label: string, uiTheme: ThemeManifestEntry['uiTheme']): ThemeManifestEntry => ({ id, label, kind: 'color', uiTheme, path: `/t/${id}`, source: 'builtin' })
  const carbonDark = e('builtin:carbon-dark.json', 'Carbon Dark', 'vs-dark')
  const carbonLight = e('builtin:carbon-light.json', 'Carbon Light', 'vs')
  const minDark = e('builtin:min-dark.json', 'Min Dark', 'vs-dark')
  const minLight = e('builtin:min-light.json', 'Min Light', 'vs')
  const nova = e('ext:acme.one:Nova:color', 'Nova', 'vs-dark')
  const catalog = [carbonDark, carbonLight, minDark, minLight, nova]

  it('switches to the sibling theme of the same family', () => {
    expect(siblingTheme(minDark, 'light', catalog)).toBe(minLight)
    expect(siblingTheme(minLight, 'dark', catalog)).toBe(minDark)
    expect(siblingTheme(carbonDark, 'light', catalog)).toBe(carbonLight)
  })
  it('keeps the active theme when it already matches the kind', () => {
    expect(siblingTheme(minDark, 'dark', catalog)).toBe(minDark)
    expect(pickThemeEntry('dark', false, catalog, minDark, 'dark')).toBe(minDark)
  })
  it('falls back to the bundled Carbon theme when the theme has no sibling', () => expect(siblingTheme(nova, 'light', catalog)).toBe(carbonLight))
  it('follows the OS in System mode', () => {
    expect(pickThemeEntry('system', true, catalog, minLight, 'light')).toBe(minDark)
    expect(pickThemeEntry('system', false, catalog, minDark, 'dark')).toBe(minLight)
  })
  it('pins the requested kind regardless of the OS', () => {
    expect(pickThemeEntry('light', true, catalog, carbonDark, 'dark')).toBe(carbonLight)
    expect(pickThemeEntry('dark', false, catalog, minLight, 'light')).toBe(minDark)
  })
  it('matches extension themes by uiTheme when the name carries no kind word', () => {
    expect(pickThemeEntry('dark', true, catalog, nova, undefined)).toBe(nova)
  })
})
describe('built-in palette and file icon families', () => {
  const color = (id: string, label: string, uiTheme: ThemeManifestEntry['uiTheme'], source: ThemeManifestEntry['source'] = 'builtin'): ThemeManifestEntry =>
    ({ id, label, kind: 'color', uiTheme, path: `/t/${id}`, source })
  const icons = (id: string, label: string, source: ThemeManifestEntry['source'] = 'builtin'): ThemeManifestEntry =>
    ({ id, label, kind: 'fileIcon', path: `/t/${id}`, source })
  const carbonDark = color('builtin:carbon-dark.json', 'Carbon Dark', 'vs-dark')
  const carbonLight = color('builtin:carbon-light.json', 'Carbon Light', 'vs')
  const minDark = color('builtin:min-dark.json', 'Min Dark', 'vs-dark')
  const minLight = color('builtin:min-light.json', 'Min Light', 'vs')
  const nova = color('ext:acme.one:Nova:color', 'Nova', 'vs-dark', 'vscode-extension')

  it('maps only Carbon and Min to a palette family', () => {
    expect(paletteOf(carbonDark)).toBe('carbon')
    expect(paletteOf(carbonLight)).toBe('carbon')
    expect(paletteOf(minDark)).toBe('min')
    expect(paletteOf(minLight)).toBe('min')
    expect(paletteOf(nova)).toBeUndefined()
    expect(paletteOf(undefined)).toBeUndefined()
  })

  it('resolves the family variant from the mode', () => {
    const catalog = [carbonDark, carbonLight, minDark, minLight, nova]
    expect(paletteTheme('carbon', 'dark', false, catalog)).toBe(carbonDark)
    expect(paletteTheme('carbon', 'light', true, catalog)).toBe(carbonLight)
    expect(paletteTheme('min', 'system', true, catalog)).toBe(minDark)
    expect(paletteTheme('min', 'system', false, catalog)).toBe(minLight)
    expect(kindForMode('system', false)).toBe('light')
    expect(kindForMode('dark', false)).toBe('dark')
  })

  it('follows a user override kept by catalog dedupe', () => {
    const local = color('user:carbon-dark.json', 'Carbon Dark', 'vs-dark', 'user')
    const { catalog } = dedupeCatalog([carbonDark, carbonLight, local])
    expect(paletteTheme('carbon', 'dark', false, catalog)).toBe(local)
    expect(paletteOf(local)).toBe('carbon')
  })

  it('maps the four bundled file icon themes and ignores others', () => {
    const dawn = icons('builtin:dawn.json', 'Dawn')
    const deep = icons('builtin:deep.json', 'Deep')
    const dim = icons('builtin:dim.json', 'Dim')
    const you = icons('builtin:you.json', 'You')
    const custom = icons('ext:acme.icons:Custom:fileIcon', 'Custom', 'vscode-extension')
    const catalog = [dawn, deep, dim, you, custom]
    expect(catalog.map((e) => fileIconFamily(e))).toEqual(['dawn', 'deep', 'dim', 'you', undefined])
    expect(fileIconTheme('you', catalog)).toBe(you)
    expect(fileIconTheme('dawn', catalog)).toBe(dawn)
    expect(fileIconFamily(undefined)).toBeUndefined()
  })
})
describe('workbench css variables', () => {
  // Variables used by the workbench css without a fallback must come from the theme defaults, or they stay unset and the rule breaks.
  const bareVars = (() => {
    const css = readFileSync('src/renderer/src/styles.css', 'utf8')
    const bare = new Set<string>()
    for (const m of css.matchAll(/var\(\s*(--vscode-[a-z0-9-]+)\s*([,)])/gi)) if (m[2] === ')') bare.add(m[1])
    return [...bare]
  })()
  it.each(['carbon-dark', 'carbon-light', 'min-dark', 'min-light'])('%s defines every fallback-less workbench variable', (n) => {
    const defined = new Set(Object.keys(toCssVars(resolveColors(load(n)))))
    expect(bareVars.filter((v) => !defined.has(v))).toEqual([])
  })
})
describe('monaco conversion', () => {
  it('maps TextMate scopes to Monarch tokens', () => {
    expect(scopeToToken('keyword.operator.sql')).toBe('operator')
    expect(scopeToToken('keyword.control')).toBe('keyword')
    expect(scopeToToken('constant.numeric.integer')).toBe('number')
    expect(scopeToToken('support.function.builtin')).toBe('predefined')
  })
  it('converts the Carbon themes', () => {
    const m = toMonacoTheme(load('carbon-dark'))
    expect(m.base).toBe('vs-dark')
    for (const t of ['keyword', 'string', 'comment']) expect(m.rules.find((r) => r.token === t)?.foreground, t).toMatch(/^[0-9a-f]{3,8}$/i)
    expect(m.colors['editor.background']).toBe('#171717')
    expect(toMonacoTheme(load('carbon-light')).base).toBe('vs')
  })
})
describe('file icon themes', () => {
  const t = { iconDefinitions: { f: { iconPath: './f.svg' }, sql: { iconPath: './sql.svg' }, tgz: { fontCharacter: '\\e001', fontColor: '#f00' }, d: { iconPath: './d.svg' }, dopen: { iconPath: './do.svg' } }, fonts: [{ id: 'x', src: [] }], file: 'f', folder: 'd', folderExpanded: 'dopen', fileExtensions: { sql: 'sql', 'tar.gz': 'tgz' }, fileNames: { 'makefile': 'f' }, folderNames: { src: 'd' } }
  it('longest extension suffix wins', () => expect(pickIconId(t as never, 'a.tar.gz', 'file', false)).toBe('tgz'))
  it('extension, then default', () => { expect(pickIconId(t as never, 'q.SQL', 'file', false)).toBe('sql'); expect(pickIconId(t as never, 'zzz.unknown', 'file', false)).toBe('f') })
  it('resolves image urls against the theme base', () => expect(resolveFileIcon(t as never, 'stratum-asset://local/th/', 'x.sql', 'file')).toEqual({ kind: 'image', url: 'stratum-asset://local/th/sql.svg' }))
  it('resolves glyph icons', () => expect(resolveFileIcon(t as never, 'stratum-asset://local/th/', 'a.tar.gz', 'file')).toMatchObject({ kind: 'glyph', color: '#f00' }))
  it('expanded folder', () => expect(pickIconId(t as never, 'lib', 'folderExpanded', false)).toBe('dopen'))
})
describe('product icon themes', () => {
  it('re-points codicon glyphs and follows aliases', () => {
    const css = productIconCss({ fonts: [{ id: 'f', src: [{ path: './f.woff', format: 'woff' }] }], iconDefinitions: { database: { fontCharacter: '\\e900' }, table: 'database' } }, 'stratum-asset://local/pi/')
    expect(css).toContain('@font-face{font-family:\'stratum-pi-f\'')
    expect(css).toContain('stratum-asset://local/pi/f.woff')
    expect(css).toContain('.codicon-database::before{content:"\\e900"')
    expect(css).toContain('.codicon-table::before{content:"\\e900"')
  })

  it('refuses a glyph that would escape its CSS declaration', () => {
    const theme = { iconDefinitions: { broken: { fontCharacter: '\\' }, ok: { fontCharacter: '\\e900' } } }
    expect(hasProductIcon(theme, 'broken')).toBe(false)
    expect(hasProductIcon(theme, 'ok')).toBe(true)
    expect(productIconCss(theme, 'stratum-asset://local/pi/')).not.toContain('codicon-broken')
  })
})
