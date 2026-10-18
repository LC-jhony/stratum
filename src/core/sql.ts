/** Quote/comment-aware SQL statement utilities (the basis of DataGrip's "run statement under caret"). */

export interface StatementRange { start: number; end: number; text: string }

/** Split a script into statements on top-level `;`. Handles '...', "...", `...`, $tag$...$tag$, -- and block comments. */
export function splitStatements(sql: string): StatementRange[] {
  const out: StatementRange[] = []
  let i = 0, start = 0
  const n = sql.length
  const push = (end: number) => {
    const raw = sql.slice(start, end)
    const text = raw.trim()
    if (text && !isOnlyComments(text)) {
      const lead = raw.length - raw.trimStart().length
      out.push({ start: start + lead, end: start + lead + text.length, text })
    }
  }
  while (i < n) {
    const ch = sql[i], nx = sql[i + 1]
    if (ch === '-' && nx === '-') { i = nextLine(sql, i); continue }
    if (ch === '/' && nx === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue }
    if (ch === "'" || ch === '"' || ch === '`') { i = skipQuoted(sql, i, ch); continue }
    if (ch === '$') {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i))
      if (m) { const e = sql.indexOf(m[0], i + m[0].length); i = e < 0 ? n : e + m[0].length; continue }
    }
    if (ch === ';') { push(i); start = i + 1 }
    i++
  }
  push(n)
  return out
}

/** Statement containing the caret; if the caret sits in whitespace, the closest preceding statement (DataGrip behaviour). */
export function statementAt(sql: string, offset: number): StatementRange | undefined {
  const all = splitStatements(sql)
  if (!all.length) return undefined
  const hit = all.find((s) => offset >= s.start && offset <= s.end + 1)
  if (hit) return hit
  const before = [...all].reverse().find((s) => s.end < offset)
  return before ?? all[0]
}

const ROW_RETURNING = /^\s*(\(?\s*)*(select|with|show|describe|desc|explain|pragma|values|table)\b/i
export const returnsRows = (sql: string) => ROW_RETURNING.test(stripLeadingComments(sql))

export function stripLeadingComments(sql: string): string {
  let s = sql
  for (;;) {
    const t = s.trimStart()
    if (t.startsWith('--')) s = t.slice(nextLine(t, 0))
    else if (t.startsWith('/*')) { const e = t.indexOf('*/'); s = e < 0 ? '' : t.slice(e + 2) }
    else return t
  }
}
const isOnlyComments = (s: string) => stripLeadingComments(s).trim() === ''
const nextLine = (s: string, i: number) => { const e = s.indexOf('\n', i); return e < 0 ? s.length : e + 1 }
function skipQuoted(s: string, i: number, q: string): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\' && q !== '`') { j++; continue }
    if (s[j] === q) { if (s[j + 1] === q) { j++; continue } return j + 1 }
  }
  return s.length
}
