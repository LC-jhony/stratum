import { describe, expect, it } from 'vitest'
import { returnsRows, splitStatements, statementAt } from '../src/core/sql'
import { buildDelete, buildInsert, buildUpdate, sqlLiteral } from '../src/core/sqlgen'

describe('splitStatements', () => {
  it('splits on top-level semicolons only', () => {
    const s = splitStatements(`select 'a;b'; -- c;d\nselect "x;y", \`z;w\`; /* ; */ select 1`)
    expect(s.map((x) => x.text)).toEqual([`select 'a;b'`, `-- c;d\nselect "x;y", \`z;w\``, `/* ; */ select 1`])
  })
  it('handles dollar-quoted bodies and escaped quotes', () => {
    const s = splitStatements(`create function f() returns int as $$ begin return 1; end $$ language plpgsql; select 'it''s;ok'`)
    expect(s).toHaveLength(2)
    expect(s[1].text).toBe(`select 'it''s;ok'`)
  })
  it('drops comment-only chunks', () => expect(splitStatements('-- nothing\n;;/* x */;')).toEqual([]))
})
describe('statementAt (DataGrip caret semantics)', () => {
  const sql = 'select 1;\n\nselect 2;\nselect 3'
  it('picks the statement under the caret', () => expect(statementAt(sql, sql.indexOf('2'))?.text).toBe('select 2'))
  it('caret in blank space falls back to the preceding statement', () => expect(statementAt(sql, 10)?.text).toBe('select 1'))
})
describe('returnsRows', () => {
  it.each([['SELECT 1', true], ['  -- hi\nwith x as (select 1) select * from x', true], ['(select 1)', true], ['insert into t values (1)', false], ['create table t(a int)', false]])('%s', (sql, want) => expect(returnsRows(sql)).toBe(want))
})
describe('sqlgen', () => {
  const q = (s: string) => `"${s}"`
  it('escapes literals', () => { expect(sqlLiteral("O'Brien")).toBe("'O''Brien'"); expect(sqlLiteral(null)).toBe('NULL'); expect(sqlLiteral(3)).toBe('3') })
  it('builds UPDATE/DELETE with NULL-safe keys', () => {
    expect(buildUpdate(q, '"t"', { columns: ['id'], values: [1] }, { name: 'x' })).toBe(`UPDATE "t" SET "name" = 'x' WHERE "id" = 1`)
    expect(buildDelete(q, '"t"', { columns: ['a', 'b'], values: [1, null] })).toBe(`DELETE FROM "t" WHERE "a" = 1 AND "b" IS NULL`)
    expect(buildInsert(q, '"t"', { a: 1, b: 'z' })).toBe(`INSERT INTO "t" ("a", "b") VALUES (1, 'z')`)
  })
})
