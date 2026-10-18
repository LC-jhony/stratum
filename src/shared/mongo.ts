import type { StatementRange } from './sql'

/**
 * Statement utilities for the MongoDB console (mongosh-style shell text).
 *
 * Statements end at a top-level `;`, and — because shell scripts usually omit it — also at a
 * top-level newline whose next non-blank token starts a new `db.…` expression. Braces, brackets,
 * parens, strings and comments are tracked so a document literal spread over several lines never
 * splits. No evaluation happens here; this is pure text (matching shared/sql.ts for SQL).
 */
export function splitMongoStatements(text: string): StatementRange[] {
  const out: StatementRange[] = []
  let start = 0
  let i = 0
  const n = text.length
  const push = (end: number) => {
    const raw = text.slice(start, end)
    const trimmed = raw.trim()
    if (trimmed) {
      const lead = raw.length - raw.trimStart().length
      out.push({ start: start + lead, end: start + lead + trimmed.length, text: trimmed })
    }
  }
  let curly = 0, square = 0, round = 0
  while (i < n) {
    const ch = text[i], nx = text[i + 1]
    if (ch === '/' && nx === '/') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue }
    if (ch === '/' && nx === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue }
    if (ch === "'" || ch === '"' || ch === '`') { i = skipQuoted(text, i, ch); continue }
    if (ch === '{') curly++
    else if (ch === '}') curly = Math.max(0, curly - 1)
    else if (ch === '[') square++
    else if (ch === ']') square = Math.max(0, square - 1)
    else if (ch === '(') round++
    else if (ch === ')') round = Math.max(0, round - 1)
    else if (ch === ';' && !curly && !square && !round) { push(i); start = i + 1 }
    else if (ch === '\n' && !curly && !square && !round) {
      // A new line that starts a fresh `db.` expression begins a statement when text already accumulated.
      const rest = text.slice(i + 1)
      const m = /^[ \t]*(db\s*[.[])/.exec(rest)
      if (m && text.slice(start, i).trim()) { push(i); start = i + 1 }
    }
    i++
  }
  push(n)
  return out
}

/** Statement containing the caret; if the caret sits in whitespace, the closest preceding statement. */
export function mongoStatementAt(text: string, offset: number): StatementRange | undefined {
  const all = splitMongoStatements(text)
  if (!all.length) return undefined
  const hit = all.find((s) => offset >= s.start && offset <= s.end + 1)
  if (hit) return hit
  const before = [...all].reverse().find((s) => s.end < offset)
  return before ?? all[0]
}

function skipQuoted(s: string, i: number, q: string): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue }
    if (s[j] === q) return j + 1
  }
  return s.length
}
