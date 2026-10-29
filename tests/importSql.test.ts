import { describe, expect, it } from 'vitest'
import { isInsertStatement, scriptStatements, summarizeScript } from '../src/core/importSql'

describe('SQL script import', () => {
  it('splits statements and drops comments and empty fragments', () => {
    const sql = `-- setup\nCREATE TABLE t (id int);\n\n/* load */\nINSERT INTO t VALUES (1);\ninsert into t values (2)`
    // Leading comments travel with the statement: they stay useful in the error the server returns.
    expect(scriptStatements(sql)).toEqual(['-- setup\nCREATE TABLE t (id int)', '/* load */\nINSERT INTO t VALUES (1)', 'insert into t values (2)'])
  })

  it('does not split semicolons inside quotes or dollar blocks', () => {
    const sql = `insert into t values ('a;b');\nselect $$x;y$$;`
    expect(scriptStatements(sql)).toHaveLength(2)
  })

  it('detects INSERTs behind leading comments', () => {
    expect(isInsertStatement('-- note\nINSERT INTO t VALUES (1)')).toBe(true)
    expect(isInsertStatement(' /* c */ insert into t values (1)')).toBe(true)
    expect(isInsertStatement('create table t (id int)')).toBe(false)
  })

  it('summarises INSERTs versus other statements', () => {
    expect(summarizeScript('create table t (id int); insert into t values (1); insert into t values (2);')).toEqual({ statements: 3, inserts: 2, other: 1 })
    expect(summarizeScript('-- nothing')).toEqual({ statements: 0, inserts: 0, other: 0 })
  })
})
