import { describe, expect, it } from 'vitest'
import { detectDelimiter, parseCsv } from '../src/core/csv'

describe('detectDelimiter', () => {
  it('sniffs comma, semicolon, tab and pipe', () => {
    expect(detectDelimiter('a,b\n1,2')).toBe(',')
    expect(detectDelimiter('a;b\n1;2')).toBe(';')
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t')
    expect(detectDelimiter('a|b\n1|2')).toBe('|')
  })

  it('ignores delimiters inside quotes and blank leading lines', () => {
    expect(detectDelimiter('\n  \n"a;b;c",d\n1,2')).toBe(',')
    expect(detectDelimiter('"only, commas"')).toBe(',')
  })

  it('uses the first informative line', () => {
    expect(detectDelimiter('title line without separators\na;b\n1;2')).toBe(';')
  })
})

describe('parseCsv', () => {
  it('parses headers, quoting, escaped quotes and CRLF', () => {
    const t = parseCsv('\uFEFFid,name,note\r\n1,"Ada, A.","say ""hi"""\r\n2,Bob,\r\n')
    expect(t.headers).toEqual(['id', 'name', 'note'])
    expect(t.rows).toEqual([['1', 'Ada, A.', 'say "hi"'], ['2', 'Bob', '']])
  })

  it('keeps embedded newlines inside quotes', () => {
    const t = parseCsv('a,b\n1,"line 1\nline 2"')
    expect(t.rows).toEqual([['1', 'line 1\nline 2']])
  })

  it('pads ragged rows and names missing headers', () => {
    const t = parseCsv('a,b\n1\n2,3,4')
    expect(t.headers).toEqual(['a', 'b', 'column_3'])
    expect(t.rows).toEqual([['1', '', ''], ['2', '3', '4']])
  })

  it('generates headers when the file has none, and accepts an explicit delimiter', () => {
    const t = parseCsv('1;2\n3;4', { hasHeader: false, delimiter: ';' })
    expect(t.delimiter).toBe(';')
    expect(t.headers).toEqual(['column_1', 'column_2'])
    expect(t.rows).toEqual([['1', '2'], ['3', '4']])
  })

  it('drops a trailing blank line but keeps empty cells', () => {
    expect(parseCsv('a,b\n,\n\n').rows).toEqual([['', '']])
  })

  it('handles a quoted empty string and a lone quote character', () => {
    expect(parseCsv('a,b\n"",x').rows).toEqual([['', 'x']])
    expect(parseCsv('a\n"unterminated').rows).toEqual([['unterminated']])
  })

  it('returns no rows for an empty file', () => {
    expect(parseCsv('')).toEqual({ delimiter: ',', headers: [], rows: [] })
  })
})
