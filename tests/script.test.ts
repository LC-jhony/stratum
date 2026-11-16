import { describe, expect, it } from 'vitest'
import { exportFormatFromPath, parseCommandLine, parseScript, ScriptError } from '../src/core/script'

describe('parseScript', () => {
  it('keeps statements and commands in source order, without needing a semicolon', () => {
    const items = parseScript(`select 1\n@set who = alice\nselect '\${who}';\n@export out.csv`)
    expect(items.map((i) => i.type)).toEqual(['sql', 'set', 'sql', 'export'])
    expect(items[0]).toMatchObject({ type: 'sql', text: 'select 1' })
    expect(items[1]).toMatchObject({ type: 'set', name: 'who', value: 'alice', line: 2 })
    expect(items[2]).toMatchObject({ type: 'sql', text: "select '${who}'" })
    expect(items[3]).toMatchObject({ type: 'export', path: 'out.csv', format: 'csv', explicitFormat: false })
  })

  it('recognizes commands with leading whitespace and any case', () => {
    const items = parseScript('   @SET x = 1\n\t@Include data.sql\n  @EXPORT report.json json')
    expect(items.map((i) => i.type)).toEqual(['set', 'include', 'export'])
    expect(items[2]).toMatchObject({ path: 'report.json', format: 'json', explicitFormat: true })
  })

  it('splits multiple SQL statements between commands', () => {
    const items = parseScript('select 1; select 2;\n@include more.sql\nselect 3;')
    expect(items.map((i) => i.type)).toEqual(['sql', 'sql', 'include', 'sql'])
    expect(items.filter((i) => i.type === 'sql').map((i) => (i as { text: string }).text)).toEqual(['select 1', 'select 2', 'select 3'])
  })

  it('never treats a command-looking line inside a string as a command', () => {
    const items = parseScript(`select 'first\n@set x = 1\nlast' as note`)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'sql' })
    expect((items[0] as { text: string }).text).toContain('@set x = 1')
  })

  it('ignores command-looking lines inside comments and dollar-quoted bodies', () => {
    const comment = parseScript('/*\n@set x = 1\n*/\nselect 1')
    expect(comment.map((i) => i.type)).toEqual(['sql'])
    expect((comment[0] as { text: string }).text).toContain('@set x = 1')

    const dollar = parseScript("create function f() returns int as $$\n@export nope.csv\n$$ language sql")
    expect(dollar.map((i) => i.type)).toEqual(['sql'])
    expect((dollar[0] as { text: string }).text).toContain('@export nope.csv')
  })

  it('leaves unknown @ lines as SQL (MySQL user variables)', () => {
    const items = parseScript('@foo := 1;\nselect @foo')
    expect(items.map((i) => i.type)).toEqual(['sql', 'sql'])
    expect((items[0] as { text: string }).text).toBe('@foo := 1')
  })

  it('accepts quoted paths with spaces and a trailing command semicolon', () => {
    const items = parseScript('@include "seeds/my data.sql";\n@export \'reports/today report.csv\';')
    expect(items[0]).toMatchObject({ type: 'include', path: 'seeds/my data.sql' })
    expect(items[1]).toMatchObject({ type: 'export', path: 'reports/today report.csv', format: 'csv' })
  })

  it('keeps equals signs and quoted semicolons in @set values', () => {
    const items = parseScript("@set query = select 'a=b;c'\n@set flag = 1;")
    expect(items[0]).toMatchObject({ name: 'query', value: "select 'a=b;c'" })
    expect(items[1]).toMatchObject({ name: 'flag', value: '1' })
  })

  it('reports the line of a malformed command', () => {
    expect(() => parseScript('select 1\n@set broken\nselect 2')).toThrow(ScriptError)
    expect(() => parseScript('\n@set 1x = y')).toThrow('Line 2')
    expect(() => parseScript('@export out.csv nope')).toThrow('unknown export format')
    expect(() => parseScript('@include   ')).toThrow('needs a file path')
    expect(() => parseScript("@export 'unterminated")).toThrow('unterminated quoted path')
  })

  it('returns no items for empty or comment-only scripts', () => {
    expect(parseScript('')).toEqual([])
    expect(parseScript('  \n-- only a comment\n/* and a block */')).toEqual([])
  })
})

describe('export formats', () => {
  it('infers a format from the extension', () => {
    expect(exportFormatFromPath('a.csv')).toBe('csv')
    expect(exportFormatFromPath('a.TSV')).toBe('tsv')
    expect(exportFormatFromPath('a.txt')).toBe('tsv')
    expect(exportFormatFromPath('a.json')).toBe('json')
    expect(exportFormatFromPath('a.sql')).toBe('insert')
    expect(exportFormatFromPath('a.xlsx')).toBe('xlsx')
    expect(exportFormatFromPath('no-extension')).toBe('csv')
  })

  it('lets an explicit format win', () => {
    expect(parseCommandLine('@export dump.txt json')).toMatchObject({ path: 'dump.txt', format: 'json', explicitFormat: true })
    expect(parseCommandLine('@export "with space.csv" semicolon')).toMatchObject({ path: 'with space.csv', format: 'semicolon' })
  })
})
