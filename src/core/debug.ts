/**
 * PL/pgSQL debugger rules that do not need a server: the `PLDBGBREAK` notice, the target call
 * and the validation that keeps unsupported routines out of a session.
 *
 * The debugger talks to the `pldbgapi` / `plugin_debugger` proxy API. The target announces the
 * port where it is waiting with a NOTICE; the controller attaches to that port. Nothing here
 * opens a connection, which keeps the tricky grammar testable.
 */
import type { DebugRoutine } from '../shared/types'
import { qualify } from './quoting'

/** Rows kept from the routine result. One extra row is fetched to detect truncation. */
export const MAX_DEBUG_ROWS = 500

/** How long the target may take to announce its debug port (DBeaver waits 50 s). */
export const DEBUG_PORT_TIMEOUT_MS = 50_000

/** Pseudo-types cannot be passed by a generated call: the server cannot infer a concrete type. */
const PSEUDO_TYPES = new Set([
  'any', 'anyelement', 'anyarray', 'anynonarray', 'anyenum', 'anyrange', 'anymultirange',
  'anycompatible', 'anycompatiblearray', 'anycompatiblenonarray', 'anycompatiblerange',
  'anycompatiblemultirange', 'record', 'cstring', 'internal', 'trigger', 'event_trigger',
  'language_handler', 'fdw_handler', 'index_am_handler', 'table_am_handler', 'tsm_handler',
  'void', 'unknown',
])

/** Canonical type name without schema quoting, for the pseudo-type comparison. */
const bareType = (type: string): string => type
  .trim()
  .toLowerCase()
  .replace(/"/g, '')
  .replace(/^pg_catalog\./, '')

/**
 * Port from a `PLDBGBREAK:<port>` NOTICE. `pldebugger` emits the magic word as the whole
 * message; the regex accepts surrounding whitespace but nothing else, so an unrelated notice
 * that merely mentions the word cannot open a debug session.
 */
export function parseDebugNotice(text: string | undefined | null): number | undefined {
  if (!text) return undefined
  const m = /^\s*PLDBGBREAK\s*:\s*(\d{1,5})\b/.exec(text)
  if (!m) return undefined
  const port = Number(m[1])
  return port > 0 && port <= 65_535 ? port : undefined
}

/** Routines the debugger can invoke and control. Throws one actionable message per problem. */
export function validateRoutineForDebug(routine: DebugRoutine): void {
  const label = `${routine.schema}.${routine.name}`
  if (routine.language.toLowerCase() !== 'plpgsql') {
    throw new Error(`${label} is written in ${routine.language}. The debugger supports PL/pgSQL routines only.`)
  }
  if (routine.kind === 'function' && bareType(routine.returnType) === 'trigger') {
    throw new Error(`${label} is a trigger function. Trigger functions run from a trigger, not from the debugger.`)
  }
  if (routine.returnsSet && bareType(routine.returnType) === 'record') {
    throw new Error(`${label} returns SETOF record. Add a column definition list (RETURNS TABLE) or debug a regular function.`)
  }
  if (routine.variadic) {
    throw new Error(`${label} has a VARIADIC parameter. Call the routine from a console and attach a global breakpoint instead.`)
  }
  for (const arg of routine.arguments) {
    const type = bareType(arg.type)
    if (PSEUDO_TYPES.has(type) || type.startsWith('any')) {
      throw new Error(`${label} uses the pseudo-type ${arg.type} for "${arg.name}". The debugger cannot build a value for it.`)
    }
  }
}

/** True when the value list fills every required parameter and only omits trailing defaults. */
function checkedValues(routine: DebugRoutine, values: readonly string[]): string[] {
  const args = routine.arguments
  if (values.length > args.length) {
    throw new Error(`${routine.name} takes ${args.length} parameter${args.length === 1 ? '' : 's'}; ${values.length} values were provided.`)
  }
  const provided = args.map((_, i) => values[i] ?? '')
  let end = provided.length
  while (end > 0 && !provided[end - 1].trim()) end--
  for (let i = 0; i < end; i++) {
    if (provided[i].trim()) continue
    const arg = args[i]
    throw new Error(arg.optional
      ? `Parameter "${arg.name}" is empty. Optional parameters can only be omitted at the end.`
      : `Parameter "${arg.name}" is required.`)
  }
  for (let i = end; i < args.length; i++) {
    if (!args[i].optional) throw new Error(`Parameter "${args[i].name}" is required.`)
  }
  return provided.slice(0, end)
}

/**
 * Target invocation. Each value is a SQL expression wrapped in parentheses and cast to the
 * declared parameter type, so `42`, `'ana'` and `now()` all reach the routine correctly.
 *
 * Function results are bounded: an accidental `RETURNS SETOF` over a huge table must not
 * buffer the whole database in the debugger. Procedures are plain `CALL` statements.
 */
export function buildRoutineCall(routine: DebugRoutine, values: readonly string[] = []): string {
  validateRoutineForDebug(routine)
  const args = checkedValues(routine, values)
  const list = args.map((value, i) => `(${value.trim()})::${routine.arguments[i].type}`).join(', ')
  const call = `${qualify('postgres', routine.schema, routine.name)}(${list})`
  if (routine.kind === 'procedure') return `CALL ${call}`
  if (routine.returnsSet) return `SELECT * FROM ${call} LIMIT ${MAX_DEBUG_ROWS + 1}`
  return `SELECT * FROM (SELECT ${call} AS "result") AS "stratum_debug" LIMIT ${MAX_DEBUG_ROWS + 1}`
}

/** One-line label for tabs, dialogs and logs. */
export function routineLabel(routine: Pick<DebugRoutine, 'schema' | 'name' | 'signature'>): string {
  return `${routine.schema}.${routine.name}${routine.signature.startsWith('(') ? routine.signature : `(${routine.signature})`}`
}

/** Number of lines in a routine body; 0 for an empty body. */
export function sourceLineCount(text: string | undefined): number {
  if (!text) return 0
  const lines = text.split('\n')
  return lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

/** Breakpoints are 1-based body lines. Line -1 is the entry breakpoint and is not a gutter line. */
export function isValidBreakpointLine(text: string | undefined, line: number): boolean {
  return Number.isInteger(line) && line >= 1 && line <= sourceLineCount(text)
}

/** `pldbg_get_source` returns the body starting at BEGIN; keep the gutter in sync with it. */
export function sourceExcerpt(text: string, around: number, radius = 0): { first: number; lines: string[] } {
  const all = text.split('\n')
  const line = Math.max(1, Math.min(all.length, Math.trunc(around) || 1))
  const first = Math.max(1, line - radius)
  const last = Math.min(all.length, line + radius)
  return { first, lines: all.slice(first - 1, last) }
}
