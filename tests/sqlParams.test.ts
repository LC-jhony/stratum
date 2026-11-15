import { describe, expect, it } from 'vitest'
import { applyVariables, findParams, substituteParams } from '../src/core/sqlParams'

describe('applyVariables', () => {
  it('expands braced and parenthesized names', () => {
    expect(applyVariables('select * from ${schema}.users where id = $(id)', { schema: 'public', id: '7' }))
      .toBe('select * from public.users where id = 7')
  })

  it('leaves unknown names untouched so they still prompt as parameters', () => {
    expect(applyVariables('select * from ${schema}.users', {})).toBe('select * from ${schema}.users')
    expect(applyVariables('select * from ${schema}.users where id = $(id)', { schema: 'public' }))
      .toBe('select * from public.users where id = $(id)')
  })

  it('honours an explicitly empty value instead of falling through', () => {
    expect(applyVariables("select '${value}'", { value: '' })).toBe("select ''")
  })

  it('does not touch bind parameters or hash-quoted names', () => {
    expect(applyVariables('select * from t where id = :id and name = #name#', { id: '1', name: 'Ana' }))
      .toBe('select * from t where id = :id and name = #name#')
  })

  it('expands only the first-level name of a malformed template', () => {
    expect(applyVariables('select ${a', { a: 'x' })).toBe('select ${a')
  })
})

describe('findParams and substituteParams', () => {
  it('finds braced parameters after variable expansion', () => {
    const sql = applyVariables('select * from ${schema}.t where id = ${id}', { schema: 'public' })
    const params = findParams(sql, 'postgres')
    expect(params.map((p) => p.name)).toEqual(['id'])
  })

  it('renders quoted and bind-style values with SQL escaping', () => {
    const sql = "select :'name', :id, ${raw}"
    const params = findParams(sql, 'postgres')
    expect(substituteParams(sql, params, { name: "O'Brien", id: '42', raw: 'now()' }))
      .toBe("select 'O''Brien', 42, now()")
  })

  it('leaves parameters without a value untouched', () => {
    const sql = 'select ${kept}'
    expect(substituteParams(sql, findParams(sql, 'postgres'), {})).toBe('select ${kept}')
  })
})
