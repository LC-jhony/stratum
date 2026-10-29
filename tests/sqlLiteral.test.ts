import { describe, expect, it } from 'vitest'
import { exportText } from '../src/core/export'
import { buildDelete, buildInsert, buildUpdate, literalFor } from '../src/core/sqlgen'
import type { ColumnMeta } from '../src/shared/types'

const cols: ColumnMeta[] = [{ name: 'id' }, { name: 'path' }]

describe('SQL literal escaping', () => {
  it('doubles backslashes for MySQL-family dialects and leaves ANSI dialects alone', () => {
    expect(literalFor('mysql')('C:\\tmp\\a')).toBe("'C:\\\\tmp\\\\a'")
    expect(literalFor('mariadb')('a\\b')).toBe("'a\\\\b'")
    expect(literalFor('postgres')('C:\\tmp')).toBe("'C:\\tmp'")
  })

  it('still escapes single quotes in every dialect', () => {
    expect(literalFor('postgres')("O'Brien")).toBe("'O''Brien'")
    expect(literalFor('mysql')("O'\\Brien")).toBe("'O''\\\\Brien'")
  })

  it('uses the dialect rules in grid UPDATE/DELETE/INSERT statements', () => {
    const q = (s: string) => `\`${s}\``
    expect(buildUpdate(q, '`t`', { columns: ['id'], values: [1] }, { path: 'C:\\x' }, 'mysql')).toBe("UPDATE `t` SET `path` = 'C:\\\\x' WHERE `id` = 1")
    expect(buildDelete(q, '`t`', { columns: ['id'], values: [1] }, 'mysql')).toContain('WHERE `id` = 1')
    expect(buildInsert(q, '`t`', { path: 'a\\b' }, 'mysql')).toContain("'a\\\\b'")
  })

  it('uses the dialect rules in exported INSERTs', () => {
    const sql = exportText(cols, [[1, 'C:\\tmp']], 'insert', 'files', 'mysql')
    expect(sql).toContain("'C:\\\\tmp'")
    expect(exportText(cols, [[1, 'C:\\tmp']], 'insert', 'files', 'postgres')).toContain("'C:\\tmp'")
  })
})

describe('CSV formula protection', () => {
  const rows = [['=1+1', '=cmd|"/c calc"!A1'], ['-5.20', '+3'], ['@user', 'plain'], ['-cmd', ' ']]
  const csv = () => exportText(cols, rows, 'csv', 't', 'postgres', { neutralizeFormulas: true }).split('\n')

  it('prefixes the text cells a spreadsheet would execute', () => {
    const out = csv()
    expect(out[0]).toBe("\uFEFFid,path")
    expect(out[1]).toBe("'=1+1,\"'=cmd|\"\"/c calc\"\"!A1\"")
    expect(out[2]).toBe('-5.20,+3')
    expect(out[3]).toBe("'@user,plain")
    expect(out[4]).toBe("'-cmd, ")
  })

  it('leaves values alone when the option is off', () => {
    const out = exportText(cols, rows, 'csv', 't', 'postgres').split('\n')
    expect(out[1]).toBe('=1+1,"=cmd|""/c calc""!A1"')
  })

  it('does not affect JSON or SQL INSERT exports', () => {
    const json = JSON.parse(exportText(cols, rows, 'json', 't', 'postgres', { neutralizeFormulas: true }))
    expect(json[0].id).toBe('=1+1')
    expect(exportText(cols, rows, 'insert', 't', 'postgres', { neutralizeFormulas: true })).toContain("'=1+1'")
  })
})
