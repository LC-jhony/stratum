import { describe, expect, it } from 'vitest'
import { buildInsertStatements, columnTypes, createTableSql, type DesignerTable } from '../src/core/ddl'

const base: DesignerTable = {
  name: 'users',
  columns: [
    { name: 'id', type: 'integer', nullable: false, primaryKey: true },
    { name: 'email', type: 'text', nullable: false, primaryKey: false, unique: true },
    { name: 'note', type: 'text', nullable: true, primaryKey: false, default: "'n/a'" },
  ],
}

describe('createTableSql', () => {
  it('quotes identifiers, emits constraints and copies type/default expressions', () => {
    const sql = createTableSql('postgres', base)
    expect(sql).toBe([
      'create table "users" (',
      '  "id" integer not null,',
      '  "email" text not null unique,',
      `  "note" text default 'n/a',`,
      '  primary key ("id")',
      ');',
    ].join('\n'))
  })

  it('qualifies the schema and supports composite keys', () => {
    const sql = createTableSql('mysql', {
      schema: 'app', name: 'members',
      columns: [
        { name: 'team', type: 'int', nullable: false, primaryKey: true },
        { name: 'user', type: 'int', nullable: false, primaryKey: true },
      ],
    })
    expect(sql).toContain('create table `app`.`members`')
    expect(sql).toContain('primary key (`team`, `user`)')
  })

  it('rejects empty names and duplicate columns', () => {
    expect(() => createTableSql('postgres', { name: ' ', columns: base.columns })).toThrow(/Table name/)
    expect(() => createTableSql('postgres', { name: 't', columns: [] })).toThrow(/at least one column/)
    expect(() => createTableSql('postgres', { name: 't', columns: [
      { name: 'a', type: 'text', nullable: true, primaryKey: false },
      { name: 'A', type: 'text', nullable: true, primaryKey: false },
    ] })).toThrow(/Duplicate column/)
    expect(() => createTableSql('postgres', { name: 't', columns: [{ name: 'a', type: ' ', nullable: true, primaryKey: false }] })).toThrow(/needs a type/)
  })

  it('offers dialect types with a generic fallback', () => {
    expect(columnTypes('postgres')).toContain('jsonb')
    expect(columnTypes('oracle')).toContain('varchar2(255)')
    expect(columnTypes('snowflake')).toEqual(columnTypes('generic'))
  })
})

describe('buildInsertStatements', () => {
  it('builds one multi-row INSERT with quoted identifiers and literals', () => {
    const [sql] = buildInsertStatements('postgres', { schema: 'public', name: 'users' }, ['id', 'name'], [['1', 'Ada'], ['2', "O'Hara"]])
    // Cells are text (CSV has no types), so every value is quoted and the server casts it.
    expect(sql).toBe(`insert into "public"."users" ("id", "name") values\n('1', 'Ada'),\n('2', 'O''Hara');`)
  })

  it('keeps empty strings distinct from NULL', () => {
    const [sql] = buildInsertStatements('generic', { name: 't' }, ['a'], [[''], [null]])
    expect(sql).toContain("('')")
    expect(sql).toContain('(NULL)')
  })

  it('splits large inputs into batches and returns nothing for no rows', () => {
    const rows = Array.from({ length: 5 }, (_v, i) => [String(i)])
    expect(buildInsertStatements('sqlite', { name: 't' }, ['n'], rows, 2)).toHaveLength(3)
    expect(buildInsertStatements('sqlite', { name: 't' }, ['n'], [])).toEqual([])
    expect(() => buildInsertStatements('sqlite', { name: 't' }, [], [[]])).toThrow(/no columns/)
  })

  it('escapes backslashes only in MySQL-family dialects', () => {
    expect(buildInsertStatements('mysql', { name: 't' }, ['p'], [['C:\\tmp']])[0]).toContain("'C:\\\\tmp'")
    expect(buildInsertStatements('postgres', { name: 't' }, ['p'], [['C:\\tmp']])[0]).toContain("'C:\\tmp'")
  })
})
