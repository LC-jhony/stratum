import { describe, expect, it } from 'vitest'
import { filterRows, sortRows } from '../src/core/gridView'

describe('result view: quick filter', () => {
  const rows = [[1, 'Ada, countess', null], [2, 'bob', true], [3, null, false]]
  it('matches any column, case-insensitively', () => {
    expect(filterRows(rows, 'ADA').map((r) => r[0])).toEqual([1])
    expect(filterRows(rows, 'true').map((r) => r[0])).toEqual([2])
  })
  it('matches nulls by their grid text and ignores blank queries', () => {
    expect(filterRows(rows, 'null').map((r) => r[0])).toEqual([1, 3])
    expect(filterRows(rows, '   ')).toBe(rows)
  })
  it('searches JSON payloads, not "[object Object]"', () => {
    expect(filterRows([['x', { a: 'needle' }]], 'needle')).toHaveLength(1)
  })
})

describe('result view: column sort', () => {
  it('sorts numbers numerically with nulls last', () => {
    const out = sortRows([[10], [2], [null], [7]], { col: 0, dir: 1 })
    expect(out.map((r) => r[0])).toEqual([2, 7, 10, null])
  })
  it('treats numeric-looking strings (driver numerics) by value', () => {
    const out = sortRows([['10'], ['2'], ['9'], ['x']], { col: 0, dir: 1 })
    expect(out.map((r) => r[0])).toEqual(['2', '9', '10', 'x'])
  })
  it('sorts text case-insensitively and keeps equal values stable', () => {
    const out = sortRows([['b', 1], ['A', 2], ['a', 3], ['B', 4]], { col: 0, dir: 1 })
    expect(out.map((r) => r[1])).toEqual([2, 3, 1, 4])
  })
  it('descending mirrors SQL: reversed, so nulls move first', () => {
    const out = sortRows([[1], [3], [null], [2]], { col: 0, dir: -1 })
    expect(out.map((r) => r[0])).toEqual([null, 3, 2, 1])
  })
  it('leaves the array untouched when there is no sort', () => {
    const rows = [[1]]
    expect(sortRows(rows, null)).toBe(rows)
  })
})
