#!/usr/bin/env node
/**
 * Extract the full per-dialect token vocabulary from the DataGrip dialect modules.
 *
 * Provenance: DataGrip 2026.2.6 (build DB-262.10968.148, snap revision 312).
 * Input: the modules directory containing `intellij.database.dialects.*.jar`
 * (plugins/DatabaseTools/lib/modules).
 *
 * Every lexer/parser token a dialect knows is declared in its `<Prefix>Types` interface
 * as `token("WORD")` (e.g. `CH_PREWHERE = CHouseElementFactory.token("PREWHERE")`), and
 * TokensHelper builds the dialect's keyword set from those fields. The `*ReservedKeywords`
 * classes only carry the reserved subset and are empty marker interfaces in several
 * dialects (Db2, ClickHouse, Spike, ...), so the vocabulary is recovered here from the
 * `*Types` classes by disassembling their static initializer with `javap` (needs JDK 21+)
 * and collecting the string literals passed to the `token(String)` factory.
 *
 * Synthetic plugin tokens that users never type are filtered out: IDENTIFIER, STRING,
 * NUMBER, COMMENT, WHITESPACE, `*_TOKEN`, `PG_CONTEXT`, ... Punctuation tokens are
 * dropped by the all-caps word filter.
 *
 * Output is JSON on stdout: { "<jar>": string[] } with sorted, deduplicated words.
 *
 * Usage: node scripts/datagrip-tokens.mjs <modules-dir> > tokens.json
 */
import { readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** Plugin-internal tokens that are not keywords (never suggested to users). */
const SYNTHETIC = new Set([
  'IDENTIFIER', 'STRING', 'NUMBER', 'COMMENT', 'WHITESPACE', 'EOF',
  'SQL_IDENT', 'SQL_IDENT_DELIMITED',
  'PG_CONTEXT', 'PG_DATATYPE_NAME', 'PG_DDL_COMMAND',
  'PG_EXCEPTION_CONTEXT', 'PG_EXCEPTION_DETAIL', 'PG_EXCEPTION_HINT',
])
const isWord = (w) => /^[A-Z][A-Z0-9_]*$/.test(w) && w.length >= 2
const isJunk = (w) => SYNTHETIC.has(w) || /_TOKEN(_|$)/.test(w)

const root = process.argv[2]
if (!root) {
  console.error('usage: node scripts/datagrip-tokens.mjs <modules-dir>')
  process.exit(2)
}

/** Words passed to the token(String) factory inside a class static initializer. */
export function tokenWords(classFile) {
  const text = execFileSync('javap', ['-c', '-p', classFile], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  const lines = text.split('\n')
  const ldc = /^\s*\d+:\s+(?:ldc|ldc_w)\s+#\d+\s+\/\/\s*String (.*)$/
  const call = /^\s*\d+:\s+invokestatic.*\.token:\(Ljava\/lang\/String;\)/
  const words = new Set()
  for (let i = 0; i < lines.length - 1; i++) {
    const m = ldc.exec(lines[i])
    if (m && call.test(lines[i + 1]) && isWord(m[1]) && !isJunk(m[1])) words.add(m[1])
  }
  return words
}

const result = {}
for (const jar of readdirSync(root).filter((f) => /^intellij\.database\.dialects\..*\.jar$/.test(f)).sort()) {
  const jarPath = path.join(root, jar)
  const entries = execFileSync('unzip', ['-Z1', jarPath], { encoding: 'utf8' }).split('\n')
    .filter((e) => /\/[A-Za-z0-9$]+(?:Types|Tokens)\.class$/.test(e) && !/Keywords\.class$/.test(e) && !/ElementTypes/.test(e))
  if (!entries.length) continue
  const tmp = mkdtempSync(path.join(tmpdir(), 'datagrip-tokens-'))
  try {
    execFileSync('unzip', ['-o', '-q', '-j', jarPath, ...entries, '-d', tmp])
    const words = new Set()
    for (const e of entries) {
      try { for (const w of tokenWords(path.join(tmp, path.basename(e)))) words.add(w) } catch { /* unreadable class: skip */ }
    }
    const name = jar.replace(/^intellij\.database\.dialects\./, '').replace(/\.jar$/, '')
    result[name] = [...words].sort()
    console.error(`${name.padEnd(16)} tokens: ${result[name].length}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
console.log(JSON.stringify(result))
