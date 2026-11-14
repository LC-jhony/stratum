import { describe, expect, it } from 'vitest'
import { formatSql } from '../src/core/sqlFormat'

describe('formatSql', () => {
  it('formats PostgreSQL and uppercases keywords by default', () => {
    expect(formatSql('select a,b from t where x=1', 'postgres')).toBe('SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  x = 1')
  })

  it('keeps comments attached to the following line', () => {
    expect(formatSql('select * from t -- note\nwhere a=1', 'generic')).toContain('t -- note\nWHERE')
  })

  it('returns empty input untouched', () => {
    expect(formatSql('', 'postgres')).toBe('')
    expect(formatSql('   \n', 'mysql')).toBe('   \n')
  })

  it('honors the keyword case preference', () => {
    expect(formatSql('SELECT a FROM t', 'generic', { keywordCase: 'lower' })).toBe('select\n  a\nfrom\n  t')
    expect(formatSql('select a from t', 'generic', { keywordCase: 'preserve' })).toBe('select\n  a\nfrom\n  t')
  })

  it('maps provider dialects to their formatter grammar', () => {
    expect(formatSql('select top 1 a from t', 'mssql')).toContain('TOP 1')
    expect(formatSql("select nvl(a, 'x') from dual", 'oracle')).toContain("nvl(a, 'x')")
    expect(formatSql('select `a` from `t` limit 1', 'mysql')).toContain('`a`')
    expect(formatSql('select a from t', 'generic')).toContain('FROM')
  })

  it('formats multiple statements with a blank line between them', () => {
    const out = formatSql('select 1; select 2;', 'sqlite')
    expect(out).toContain('SELECT\n  1;')
    expect(out).toContain('SELECT\n  2;')
    expect(out.indexOf('SELECT\n  2;')).toBeGreaterThan(out.indexOf('SELECT\n  1;'))
  })

  it('clamps the indentation width to 1–8 spaces', () => {
    expect(formatSql('select a from t', 'generic', { tabWidth: 0 })).toBe('SELECT\n a\nFROM\n t')
    expect(formatSql('select a from t', 'generic', { tabWidth: 99 })).toBe('SELECT\n        a\nFROM\n        t')
  })
})
