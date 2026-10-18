import { describe, expect, it } from 'vitest'
import { findParams, substituteParams } from '../src/core/sqlParams'
import { exportText } from '../src/core/export'
import type { ColumnMeta } from '../src/shared/types'

describe('SQL parameters (DataGrip parameter-patterns)', () => {
  it('finds colon parameters only where the dialect supports them', () => {
    const sql = 'select * from t where id = :id'
    expect(findParams(sql, 'postgres').map((p) => p.name)).toEqual(['id'])
    expect(findParams(sql, 'mysql')).toEqual([])
  })
  it('finds quoted, braced, paren and hash forms everywhere', () => {
    const sql = "select :'name', :\"col\", ${a}, $(b), #c#"
    const names = findParams(sql, 'generic').map((p) => `${p.kind}:${p.name}`)
    expect(names).toEqual(['string:name', 'identifier:col', 'raw:a', 'raw:b', 'raw:c'])
    expect(findParams(sql, 'mssql')).toHaveLength(3)
  })
  it('does not mistake casts or digit runs for parameters', () => {
    expect(findParams('select a::text, 12:30 from t', 'postgres')).toEqual([])
  })
  it('substitutes with escaping per kind and repeats every occurrence', () => {
    const sql = "select * from t where a = :'name' and b = :name and c = :name"
    const params = findParams(sql, 'generic')
    const out = substituteParams(sql, params, { name: "O'Brien" })
    expect(out).toBe("select * from t where a = 'O''Brien' and b = 'O''Brien' and c = 'O''Brien'")
  })
  it('binds :name like DataGrip: numbers stay bare, text is quoted, NULL is bare', () => {
    const sql = 'select * from t where id = :id and note = :note and x is :nul'
    const values = { id: '42', note: 'a b', nul: 'null' }
    expect(substituteParams(sql, findParams(sql, 'generic'), values)).toBe("select * from t where id = 42 and note = 'a b' and x is null")
  })
  it('script variables (#name#, ${name}, $(name)) substitute verbatim', () => {
    const sql = 'select ${a}, $(b), #c# from t'
    expect(substituteParams(sql, findParams(sql, 'generic'), { a: "'x'", b: '1', c: 'now()' })).toBe("select 'x', 1, now() from t")
  })
  it('replaces from the end so offsets stay valid', () => {
    const sql = 'select ${x}, ${yy} from t'
    expect(substituteParams(sql, findParams(sql, 'generic'), { x: '1', yy: '2' })).toBe('select 1, 2 from t')
  })
})

const columns: ColumnMeta[] = [{ name: 'id' }, { name: 'name' }, { name: 'notes' }]
const rows = [[1, 'Ada, countess', 'line1\nline2'], [2, 'He said "hi"', null]]

describe('grid export (DataGrip csv-formats + JSON/INSERTs)', () => {
  it('writes CSV with a UTF-8 BOM (Excel accents) and as-needed quoting', () => {
    const csv = exportText(columns, rows, 'csv', 't', 'postgres')
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv.split('\n')[0]).toBe('\uFEFFid,name,notes')
    expect(csv).toContain('1,"Ada, countess","line1')
    expect(csv).toContain('"He said ""hi"""')
  })
  it('writes semicolon CSV with the BOM too, and TSV without it', () => {
    expect(exportText(columns, rows, 'semicolon', 't', 'postgres').startsWith('\uFEFF')).toBe(true)
    expect(exportText(columns, rows, 'tsv', 't', 'postgres').startsWith('\uFEFF')).toBe(false)
  })
  it('writes TSV with the tab separator', () => {
    const tsv = exportText(columns, rows, 'tsv', 't', 'postgres')
    expect(tsv.split('\n')[0]).toBe('id\tname\tnotes')
  })
  it('writes JSON objects keyed by column name', () => {
    const json = JSON.parse(exportText(columns, rows, 'json', 't', 'postgres')) as Record<string, unknown>[]
    expect(json[0]).toEqual({ id: 1, name: 'Ada, countess', notes: 'line1\nline2' })
    expect(json[1].notes).toBeNull()
  })
  it('writes INSERTs quoted for the dialect', () => {
    const ins = exportText(columns, rows, 'insert', 'orders', 'mysql')
    expect(ins.split('\nINSERT INTO')[0]).toBe("INSERT INTO `orders` (`id`, `name`, `notes`) VALUES (1, 'Ada, countess', 'line1\nline2');")
    expect(ins).toContain('(2, \'He said "hi"\', NULL);')
    expect(exportText(columns, rows, 'insert', 'orders', 'mssql')).toContain('INSERT INTO [orders] ([id]')
  })
})
