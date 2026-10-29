/** SQL script import: split statements the same way the console does and describe what will run. */
import { splitStatements, stripLeadingComments } from './sql'

/** Executable statements (empty and comment-only fragments are dropped). */
export const scriptStatements = (sql: string): string[] => splitStatements(sql).map((s) => s.text)

/** True when the statement is an INSERT, ignoring leading comments. */
export const isInsertStatement = (text: string): boolean => /^insert\s+into\b/i.test(stripLeadingComments(text))

export interface ScriptSummary {
  statements: number
  inserts: number
  other: number
}

/** Counts for the import preview: how many INSERTs versus everything else. */
export function summarizeScript(sql: string): ScriptSummary {
  const all = scriptStatements(sql)
  const inserts = all.filter(isInsertStatement).length
  return { statements: all.length, inserts, other: all.length - inserts }
}
