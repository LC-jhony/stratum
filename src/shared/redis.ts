import type { StatementRange } from './sql'

/**
 * Statement utilities for the Redis console (redis-cli-style text).
 *
 * Statements end at a top-level `;` or newline; quotes are tracked so an argument with spaces or
 * semicolons (`SET greeting "hola, mundo"`) never splits. This is pure text, matching shared/sql.ts
 * and shared/mongo.ts for their languages; nothing is evaluated here.
 */
export function splitRedisStatements(text: string): StatementRange[] {
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
  while (i < n) {
    const ch = text[i]
    if (ch === "'" || ch === '"') { i = skipQuoted(text, i, ch); continue }
    if (ch === ';' || ch === '\n') { push(i); start = i + 1 }
    i++
  }
  push(n)
  return out
}

/** Statement containing the caret; if the caret sits in whitespace, the closest preceding statement. */
export function redisStatementAt(text: string, offset: number): StatementRange | undefined {
  const all = splitRedisStatements(text)
  if (!all.length) return undefined
  // Unlike the SQL/Mongo readers, `end` alone is enough: it already covers a caret right after the
  // last character, and the extra pixel of tolerance would steal single-char offsets from the next line.
  const hit = all.find((s) => offset >= s.start && offset <= s.end)
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
