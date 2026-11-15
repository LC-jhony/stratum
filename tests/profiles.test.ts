import { describe, expect, it } from 'vitest'
import { connectionColor, confirmsWrites, isWriteStatement, PROFILE_PRESETS, writeKind } from '../src/core/profiles'

describe('connection profiles', () => {
  it('exposes DBeaver-style presets with a color and a write guard', () => {
    expect(PROFILE_PRESETS.dev.color).toBe('green')
    expect(PROFILE_PRESETS.test.color).toBe('yellow')
    expect(PROFILE_PRESETS.prod.color).toBe('red')
    expect(PROFILE_PRESETS.dev.confirmWrites).toBe(false)
    expect(PROFILE_PRESETS.prod.confirmWrites).toBe(true)
  })

  it('lets an explicit color or confirmation flag override the preset', () => {
    expect(connectionColor({ profile: 'prod' })).toBe('red')
    expect(connectionColor({ profile: 'prod', color: 'blue' })).toBe('blue')
    expect(connectionColor({})).toBeUndefined()
    expect(confirmsWrites({ profile: 'prod' })).toBe(true)
    expect(confirmsWrites({ profile: 'prod', confirmWrites: false })).toBe(false)
    expect(confirmsWrites({})).toBe(false)
  })
})

describe('write classification', () => {
  it('recognizes DML, DDL and DCL statements', () => {
    expect(writeKind('update t set x = 1')).toBe('DML')
    expect(writeKind('/* c */ delete from t')).toBe('DML')
    expect(writeKind('create table t (id int)')).toBe('DDL')
    expect(writeKind('grant select on t to ana')).toBe('DCL')
    expect(isWriteStatement('merge into t using s on t.id = s.id when matched then update set x = 1')).toBe(true)
  })

  it('flags data-modifying CTEs but leaves reads alone', () => {
    expect(writeKind('with x as (insert into t values (1) returning *) select * from x')).toBe('DML')
    expect(writeKind('select * from t')).toBeUndefined()
    expect(writeKind('set search_path to public')).toBeUndefined()
    expect(writeKind('-- update t set x = 1\nselect 1')).toBeUndefined()
    expect(writeKind("select 'delete from t' as example")).toBeUndefined()
  })
})
