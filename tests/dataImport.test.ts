import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { autoMapping, csvTable, insertStatements, jsonTable, mappedRows, xlsxTables, type ColumnMap } from '../src/core/dataImport'

describe('csvTable', () => {
  it('parses headers and turns empty fields into NULL', () => {
    expect(csvTable('id,name\n1,ada\n2,\n')).toEqual({
      headers: ['id', 'name'],
      rows: [['1', 'ada'], ['2', null]],
    })
  })

  it('sniffs semicolons and quoted separators', () => {
    expect(csvTable('id;"full name"\n1;"Ada; Lovelace"').rows[0]).toEqual(['1', 'Ada; Lovelace'])
  })
})

describe('jsonTable', () => {
  it('unions the keys of an array of objects', () => {
    const table = jsonTable('[{"id":1,"name":"ada"},{"id":2,"active":true}]')
    expect(table.headers).toEqual(['id', 'name', 'active'])
    expect(table.rows).toEqual([[1, 'ada', null], [2, null, true]])
  })

  it('accepts a single object and a { data: [] } wrapper', () => {
    expect(jsonTable('{"id":1}').rows).toEqual([[1]])
    expect(jsonTable('{"data":[{"id":2}]}').rows).toEqual([[2]])
  })

  it('serializes nested values and rejects invalid JSON', () => {
    expect(jsonTable('[{"tags":["a"],"meta":{"x":1}}]').rows[0]).toEqual(['["a"]', '{"x":1}'])
    expect(() => jsonTable('{oops')).toThrow('not valid')
  })

  it('returns an empty table for an empty array', () => {
    expect(jsonTable('[]')).toEqual({ headers: [], rows: [] })
  })
})

describe('xlsxTables', () => {
  it('reads every sheet with the first row as headers', () => {
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['id', 'name'], [1, 'ada'], [2, null]]), 'People')
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['x'], [9]]), 'Other')
    const base64 = XLSX.write(book, { type: 'base64', bookType: 'xlsx' }) as string
    const sheets = xlsxTables(base64)
    expect(sheets.map((s) => s.name)).toEqual(['People', 'Other'])
    expect(sheets[0]).toMatchObject({ headers: ['id', 'name'], rows: [[1, 'ada'], [2, null]] })
    expect(sheets[1].rows).toEqual([[9]])
  })
})

describe('mapping and INSERT generation', () => {
  const source = { headers: ['ID', 'full name', 'ignored'], rows: [['1', "Ada O'Neil", 'x']] }
  const map: ColumnMap[] = [
    { column: 'id', sourceIndex: 0 },
    { column: 'name', sourceIndex: 1 },
    { column: 'notes', sourceIndex: null },
  ]

  it('maps headers case-insensitively and leaves unknown targets unmapped', () => {
    expect(autoMapping(['ID', 'Name'], ['id', 'name', 'notes'])).toEqual(['ID', 'Name', null])
    expect(autoMapping(source.headers, ['id', 'name', 'notes'])).toEqual(['ID', null, null])
  })

  it('projects rows in target-column order and skips unmapped columns', () => {
    expect(mappedRows(source, map)).toEqual([['1', "Ada O'Neil"]])
  })

  it('generates multi-row INSERTs with dialect quoting and escaping', () => {
    const rows = mappedRows(source, map)
    expect(insertStatements({ target: 'public.people', dialect: 'postgres', columns: ['id', 'name'], rows }))
      .toEqual([`INSERT INTO public.people ("id", "name") VALUES\n  ('1', 'Ada O''Neil')`])
  })

  it('chunks large imports so one statement stays manageable', () => {
    const rows = Array.from({ length: 5 }, (_v, i) => [String(i)])
    const sql = insertStatements({ target: 't', dialect: 'mysql', columns: ['id'], rows }, 2)
    expect(sql).toHaveLength(3)
    expect(sql[0]).toContain("('0'),")
    expect(sql[2]).toContain("('4')")
  })
})
