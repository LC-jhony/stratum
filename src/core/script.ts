/**
 * SQL script control commands, DBeaver-style: `@set name = value`, `@include path` and
 * `@export path [format]`.
 *
 * A command is recognized only when it is the first non-space text of a line and the line starts
 * outside a string, quoted identifier, comment or dollar-quoted body. Commands also act as a
 * statement separator, so `select 1` followed by `@set x = 2` runs both without a semicolon.
 * Every `@` line that is not one of the three known commands stays SQL (MySQL user variables).
 */
import { EXPORT_FORMATS, type ExportId } from './export'
import { splitStatements } from './sql'

export type ScriptItem =
  | { type: 'sql'; text: string }
  | { type: 'set'; name: string; value: string; line: number }
  | { type: 'include'; path: string; line: number }
  | { type: 'export'; path: string; format: ExportId; explicitFormat: boolean; line: number }

/** Invalid command or argument; the message already names the offending line. */
export class ScriptError extends Error {
  constructor(message: string) { super(message); this.name = 'ScriptError' }
}

type State =
  | { kind: 'normal' }
  | { kind: 'quote'; quote: "'" | '"' | '`' }
  | { kind: 'block' }
  | { kind: 'dollar'; tag: string }

const NORMAL: State = { kind: 'normal' }
const COMMAND = /^\s*@(set|include|export)\b(.*)$/i
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/
const EXPORT_IDS = new Set<string>(EXPORT_FORMATS.map((f) => f.id))

/** Closing position of a quoted run started at `i`, or -1 when the line ends inside it. */
function quotedEnd(text: string, i: number, quote: string): number {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\' && quote !== '`') { j++; continue }
    if (text[j] === quote) {
      if (text[j + 1] === quote) { j++; continue } // doubled quote is an escaped quote
      return j + 1
    }
  }
  return -1
}

function dollarTag(text: string, i: number): string | undefined {
  const match = /^\$([A-Za-z_]\w*)?\$/.exec(text.slice(i))
  return match?.[0]
}

/** Lexer state at the end of a line; only used to know whether the next line can start a command. */
function advance(state: State, line: string): State {
  let i = 0
  let current = state
  while (i < line.length) {
    if (current.kind === 'quote') {
      const end = quotedEnd(line, i - 1, current.quote)
      if (end < 0) return current
      i = end
      current = NORMAL
      continue
    }
    if (current.kind === 'block') {
      const end = line.indexOf('*/', i)
      if (end < 0) return current
      i = end + 2
      current = NORMAL
      continue
    }
    if (current.kind === 'dollar') {
      const end = line.indexOf(current.tag, i)
      if (end < 0) return current
      i = end + current.tag.length
      current = NORMAL
      continue
    }
    const ch = line[i], next = line[i + 1]
    if (ch === '-' && next === '-') return NORMAL // the rest is a line comment, closed at EOL
    if (ch === '/' && next === '*') { current = { kind: 'block' }; i += 2; continue }
    if (ch === "'" || ch === '"' || ch === '`') { current = { kind: 'quote', quote: ch }; i++; continue }
    if (ch === '$') {
      const tag = dollarTag(line, i)
      if (tag) { current = { kind: 'dollar', tag }; i += tag.length; continue }
    }
    i++
  }
  return current
}

/** Index of `char` outside quotes, or -1. Used to split `@set name = value` without breaking values. */
function unquotedIndex(text: string, char: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = quotedEnd(text, i, ch)
      if (end < 0) return -1
      i = end - 1
      continue
    }
    if (ch === char) return i
  }
  return -1
}

function unquote(value: string): string {
  const text = value.trim()
  if (text.length >= 2 && (text[0] === "'" || text[0] === '"' || text[0] === '`') && text[text.length - 1] === text[0]) {
    return text.slice(1, -1)
  }
  return text
}

/** Remove the statement terminator a user may add after a command. */
function withoutSemicolon(value: string): string {
  const text = value.trim()
  return text.endsWith(';') && !/^['"`].*['"`]$/.test(text) ? text.slice(0, -1).trimEnd() : text
}

function parseSet(rest: string, line: number): ScriptItem {
  const at = unquotedIndex(rest, '=')
  if (at < 0) throw new ScriptError(`Line ${line}: @set needs "name = value".`)
  const rawName = rest.slice(0, at).trim().replace(/:$/, '').trim()
  if (!NAME.test(rawName)) throw new ScriptError(`Line ${line}: "${rawName}" is not a valid variable name.`)
  const value = withoutSemicolon(rest.slice(at + 1))
  return { type: 'set', name: rawName, value: unquote(value), line }
}

function parseInclude(rest: string, line: number): ScriptItem {
  const path = unquote(withoutSemicolon(rest))
  if (!path) throw new ScriptError(`Line ${line}: @include needs a file path.`)
  return { type: 'include', path, line }
}

/** Extension → format when `@export` omits one. `.txt` is tab-separated, the common SQL-tool choice. */
export function exportFormatFromPath(path: string): ExportId {
  const ext = path.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'xlsx') return 'xlsx'
  if (ext === 'json') return 'json'
  if (ext === 'sql') return 'insert'
  if (ext === 'tsv' || ext === 'txt') return 'tsv'
  if (ext === 'csv') return 'csv'
  return 'csv'
}

function parseExport(rest: string, line: number): ScriptItem {
  const text = withoutSemicolon(rest)
  if (!text) throw new ScriptError(`Line ${line}: @export needs a file path.`)
  let path: string, after: string
  if (text[0] === "'" || text[0] === '"' || text[0] === '`') {
    const end = quotedEnd(text, 0, text[0])
    if (end < 0) throw new ScriptError(`Line ${line}: @export has an unterminated quoted path.`)
    path = text.slice(1, end - 1)
    after = text.slice(end).trim()
  } else {
    const space = text.search(/\s/)
    path = space < 0 ? text : text.slice(0, space)
    after = space < 0 ? '' : text.slice(space).trim()
  }
  if (!path) throw new ScriptError(`Line ${line}: @export needs a file path.`)
  if (!after) return { type: 'export', path, format: exportFormatFromPath(path), explicitFormat: false, line }
  const format = after.toLowerCase() as ExportId
  if (!EXPORT_IDS.has(format)) {
    throw new ScriptError(`Line ${line}: unknown export format "${after}". Use one of ${[...EXPORT_IDS].join(', ')}.`)
  }
  return { type: 'export', path, format, explicitFormat: true, line }
}

/** Parse one full command line, or undefined when the line is SQL (including unknown `@` syntax). */
export function parseCommandLine(line: string, number = 1): ScriptItem | undefined {
  const match = COMMAND.exec(line)
  if (!match) return undefined
  const command = match[1].toLowerCase()
  const rest = match[2]
  if (command === 'set') return parseSet(rest, number)
  if (command === 'include') return parseInclude(rest, number)
  return parseExport(rest, number)
}

/**
 * Split a script into SQL statements and control commands in source order. Commands only count at
 * the start of a line outside a string/comment/dollar body, so a `@set` used as data is safe.
 */
export function parseScript(text: string): ScriptItem[] {
  const items: ScriptItem[] = []
  let state: State = NORMAL
  let buffer: string[] = []
  const flush = () => {
    if (!buffer.length) return
    for (const statement of splitStatements(buffer.join('\n'))) items.push({ type: 'sql', text: statement.text })
    buffer = []
  }
  for (const [index, line] of text.split('\n').entries()) {
    if (state.kind === 'normal') {
      const command = parseCommandLine(line, index + 1)
      if (command) { flush(); items.push(command); continue }
    }
    buffer.push(line)
    state = advance(state, line)
  }
  flush()
  return items
}
