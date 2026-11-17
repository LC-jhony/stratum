import { describe, expect, it } from 'vitest'
import {
  MAX_DEBUG_ROWS, buildRoutineCall, isValidBreakpointLine, parseDebugNotice, routineLabel,
  sourceExcerpt, sourceLineCount, validateRoutineForDebug,
} from '../src/core/debug'
import type { DebugRoutine } from '../src/shared/types'

const routine = (patch: Partial<DebugRoutine> = {}): DebugRoutine => ({
  oid: 42,
  schema: 'public',
  name: 'charge',
  kind: 'function',
  language: 'plpgsql',
  signature: '(id integer, amount numeric)',
  returnType: 'boolean',
  returnsSet: false,
  variadic: false,
  arguments: [
    { name: 'id', type: 'integer', optional: false },
    { name: 'amount', type: 'numeric', optional: false },
  ],
  ...patch,
})

describe('PLDBGBREAK notices', () => {
  it('reads the port pldebugger advertises', () => {
    expect(parseDebugNotice('PLDBGBREAK:51000')).toBe(51000)
    expect(parseDebugNotice('  PLDBGBREAK : 65535')).toBe(65535)
  })

  it('ignores unrelated notices and impossible ports', () => {
    expect(parseDebugNotice(undefined)).toBeUndefined()
    expect(parseDebugNotice('')).toBeUndefined()
    expect(parseDebugNotice('relation "x" does not exist')).toBeUndefined()
    expect(parseDebugNotice('hint: PLDBGBREAK:1234')).toBeUndefined()
    expect(parseDebugNotice('PLDBGBREAK:0')).toBeUndefined()
    expect(parseDebugNotice('PLDBGBREAK:70000')).toBeUndefined()
  })
})

describe('routine validation', () => {
  it('accepts a plain PL/pgSQL routine', () => {
    expect(() => validateRoutineForDebug(routine())).not.toThrow()
    expect(() => validateRoutineForDebug(routine({ kind: 'procedure', returnType: 'void' }))).not.toThrow()
  })

  it('rejects other languages, trigger functions and variadic parameters', () => {
    expect(() => validateRoutineForDebug(routine({ language: 'sql' }))).toThrow(/PL\/pgSQL/)
    expect(() => validateRoutineForDebug(routine({ returnType: 'trigger' }))).toThrow(/trigger/i)
    expect(() => validateRoutineForDebug(routine({ variadic: true }))).toThrow(/VARIADIC/)
  })

  it('rejects polymorphic parameters and SETOF record', () => {
    expect(() => validateRoutineForDebug(routine({
      arguments: [{ name: 'value', type: 'anyelement', optional: false }],
    }))).toThrow(/pseudo-type anyelement/)
    expect(() => validateRoutineForDebug(routine({ returnsSet: true, returnType: 'record' }))).toThrow(/column definition list/)
  })
})

describe('target call generation', () => {
  it('quotes identifiers and casts every expression to its parameter type', () => {
    expect(buildRoutineCall(routine(), ['42', "'ana'"]))
      .toBe('SELECT * FROM (SELECT "public"."charge"((42)::integer, (\'ana\')::numeric) AS "result") AS "stratum_debug" LIMIT 501')
  })

  it('calls procedures and keeps set-returning functions unbounded only by the row limit', () => {
    expect(buildRoutineCall(routine({ kind: 'procedure', name: 'refresh', arguments: [], signature: '' }), []))
      .toBe('CALL "public"."refresh"()')
    expect(buildRoutineCall(routine({ returnsSet: true, returnType: 'SETOF integer' }), ['1', '2']))
      .toBe(`SELECT * FROM "public"."charge"((1)::integer, (2)::numeric) LIMIT ${MAX_DEBUG_ROWS + 1}`)
  })

  it('omits trailing defaults but refuses holes and missing required values', () => {
    const withDefault = routine({
      arguments: [
        { name: 'id', type: 'integer', optional: false },
        { name: 'note', type: 'text', optional: true },
      ],
      signature: '(id integer, note text DEFAULT NULL)',
    })
    expect(buildRoutineCall(withDefault, ['7'])).toContain('"public"."charge"((7)::integer)')
    expect(buildRoutineCall(withDefault, ['7', ''])).toContain('"public"."charge"((7)::integer)')
    expect(() => buildRoutineCall(withDefault, ['', 'x'])).toThrow(/required/)
    expect(() => buildRoutineCall(routine(), ['1'])).toThrow(/amount.*required/)
    expect(() => buildRoutineCall(routine(), ['1', '2', '3'])).toThrow(/takes 2 parameters/)
  })

  it('quotes hostile identifiers instead of interpolating them', () => {
    const hostile = routine({ schema: 'we"ird', name: 'f"x', arguments: [], signature: '' })
    expect(buildRoutineCall(hostile)).toContain('"we""ird"."f""x"()')
  })
})

describe('source helpers', () => {
  it('counts body lines and validates 1-based breakpoints', () => {
    expect(sourceLineCount('')).toBe(0)
    expect(sourceLineCount('BEGIN\nRETURN 1;\nEND;\n')).toBe(3)
    expect(isValidBreakpointLine('BEGIN\nRETURN 1;\nEND;', 2)).toBe(true)
    expect(isValidBreakpointLine('BEGIN\nRETURN 1;\nEND;', 0)).toBe(false)
    expect(isValidBreakpointLine('BEGIN\nRETURN 1;\nEND;', 4)).toBe(false)
  })

  it('returns an excerpt around a line without leaving the body', () => {
    expect(sourceExcerpt('a\nb\nc\nd', 2, 1)).toEqual({ first: 1, lines: ['a', 'b', 'c'] })
    expect(sourceExcerpt('a\nb', 9, 1)).toEqual({ first: 1, lines: ['a', 'b'] })
  })

  it('labels a routine once', () => {
    expect(routineLabel({ schema: 'sales', name: 'apply', signature: '(id integer)' })).toBe('sales.apply(id integer)')
    expect(routineLabel({ schema: 'sales', name: 'apply', signature: 'id integer' })).toBe('sales.apply(id integer)')
  })
})
