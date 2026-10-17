#!/usr/bin/env node
/**
 * Generate `src/shared/sqlDialectData.ts` — per-dialect keyword and function catalogs
 * for the SQL completion engine, extracted from the installed DataGrip.
 *
 * Provenance (facts only: keyword/function names and prototypes — no DataGrip code):
 *  - DataGrip 2026.2.6, build DB-262.10968.148 (snap revision 312)
 *  - keywords:   `*Keywords.class` constant pools (reserved/optional subsets, decoded by
 *                scripts/datagrip-keywords.mjs) plus the full `token("WORD")` vocabulary
 *                of the `*Types` classes (decoded by scripts/datagrip-tokens.mjs — the
 *                reserved classes are empty marker interfaces in several dialects)
 *  - functions:  `functions.xml` resources from the same module jars
 *
 * The raw keyword arrays alternate the keyword with a dialect-prefixed duplicate
 * (`ABSOLUTE, SQL_ABSOLUTE, ...`); prefixes are discovered dynamically and collapsed.
 * Inherited lists are approximated by merging the dialect's jar with its ancestors
 * (sql92 -> family base -> dialect), because stubs (e.g. Db2ReservedKeywords) keep the
 * real data in superclasses we cannot see without a JVM decompiler.
 *
 * Usage: node scripts/datagrip-catalog.mjs <keywords.json> <tokens.json> <functions-dir> <out.ts>
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [kwPath, tokPath, fnDir, outFile] = process.argv.slice(2)
if (!kwPath || !tokPath || !fnDir || !outFile) {
  console.error('usage: node scripts/datagrip-catalog.mjs <keywords.json> <tokens.json> <functions-dir> <out.ts>')
  process.exit(2)
}

/** Dialect -> jar basenames (without the `intellij.database.dialects.` prefix), base first. */
const CHAINS = {
  generic: ['sql92'],
  postgres: ['sql92', 'postgresbase'],
  cockroach: ['sql92', 'postgresbase', 'cockroach'],
  greenplum: ['sql92', 'postgresbase', 'greenplum'],
  redshift: ['sql92', 'postgresbase', 'redshift'],
  vertica: ['sql92', 'postgresbase', 'vertica'],
  mysql: ['sql92', 'mysqlbase'],
  mariadb: ['sql92', 'mysqlbase', 'maria'],
  sqlite: ['sql92', 'sqlite'],
  mssql: ['sql92', 'mssql'],
  oracle: ['sql92', 'oracle'],
  db2: ['sql92', 'db2'],
  derby: ['sql92', 'derby'],
  h2: ['sql92', 'h2'],
  hsql: ['sql92', 'hsql'],
  sybase: ['sql92', 'sybase'],
  exasol: ['sql92', 'exasol'],
  snowflake: ['sql92', 'snowflake'],
  clickhouse: ['sql92', 'clickhouse'],
  bigquery: ['sql92', 'bigquery'],
  hive: ['sql92', 'hivebase'],
  spark: ['sql92', 'hivebase', 'spark'],
  cassandra: ['sql92', 'cassandra'],
}

const raw = JSON.parse(readFileSync(kwPath, 'utf8'))
const tokensRaw = JSON.parse(readFileSync(tokPath, 'utf8'))

/** Reserved/optional words plus the full token vocabulary for one jar. */
function wordsFor(jar) {
  const e = raw[jar]
  return { reserved: e?.reserved ?? [], optional: e?.optional ?? [], tokens: tokensRaw[jar] ?? [] }
}

function collapse(words) {
  const set = new Set(words.map((w) => w.trim()).filter(Boolean))
  const prefixes = new Set()
  for (const w of set) {
    const i = w.indexOf('_')
    if (i > 0 && i < 9 && set.has(w.slice(i + 1))) prefixes.add(w.slice(0, i))
  }
  return [...set].filter((w) => {
    const i = w.indexOf('_')
    return !(i > 0 && prefixes.has(w.slice(0, i)) && set.has(w.slice(i + 1)))
  })
}

function keywordsFor(chain) {
  const reserved = [], optional = [], tokens = []
  for (const jar of chain) {
    const e = wordsFor(jar)
    reserved.push(...e.reserved)
    optional.push(...e.optional)
    tokens.push(...e.tokens)
  }
  return {
    reserved: collapse(reserved).sort(),
    optional: collapse(optional).sort(),
    // Token texts are already canonical: no prefix collapsing here so that words such as
    // SQL_MACRO or ANSI_NULLS survive even when their tail is also a keyword on its own.
    tokens: [...new Set(tokens)].sort(),
  }
}

/** `<function><name>f</name><prototype>(args):ret</prototype>…</function>`; macros are ignored. */
function parseFunctions(xml) {
  const out = new Map()
  for (const m of xml.matchAll(/<function>([\s\S]*?)<\/function>/g)) {
    const body = m[1]
    const name = /<name>\s*([^<]+?)\s*<\/name>/.exec(body)?.[1]
    if (!name) continue
    const protos = [...body.matchAll(/<prototype>([\s\S]*?)<\/prototype>/g)]
      .map((p) => p[1].replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    const key = name.trim().toUpperCase()
    if (!out.has(key)) out.set(key, { name: name.trim(), protos })
  }
  return out
}

function functionsFor(chain) {
  // Most specific jar wins on name conflicts: iterate the chain backwards.
  const merged = new Map()
  for (let i = chain.length - 1; i >= 0; i--) {
    const dir = path.join(fnDir, chain[i])
    let xml = ''
    try { xml = readdirSync(dir).filter((f) => f.endsWith('.xml')).map((f) => readFileSync(path.join(dir, f), 'utf8')).join('\n') } catch { xml = '' }
    for (const [k, v] of parseFunctions(xml)) if (!merged.has(k)) merged.set(k, v)
  }
  return [...merged.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => [f.name.toLowerCase(), f.protos[0] ?? '', f.protos.length])
}

const keywords = {}, reservedOnly = {}, functions = {}
for (const [dialect, chain] of Object.entries(CHAINS)) {
  const kw = keywordsFor(chain)
  keywords[dialect] = [...new Set([...kw.reserved, ...kw.optional, ...kw.tokens])]
  reservedOnly[dialect] = kw.reserved
  functions[dialect] = functionsFor(chain)
}

const stamp = new Date().toISOString().slice(0, 10)
const lines = []
lines.push('/**')
lines.push(' * GENERATED FILE — do not edit by hand. Regenerate with:')
lines.push(' *   node scripts/datagrip-keywords.mjs <classes-dir> > keywords.json')
lines.push(' *   node scripts/datagrip-tokens.mjs <modules-dir> > tokens.json')
lines.push(' *   node scripts/datagrip-catalog.mjs keywords.json tokens.json <functions-dir> src/shared/sqlDialectData.ts')
lines.push(' *')
lines.push(` * Source: DataGrip 2026.2.6 (DB-262.10968.148), modules under plugins/DatabaseTools/lib/modules.`)
lines.push(` * Generated: ${stamp}. Keywords are single words (uppercase); functions carry the first`)
lines.push(' * prototype and the overload count from DataGrip\'s per-dialect functions.xml.')
lines.push(' */')
lines.push('')
lines.push('/** [name, first prototype, prototype count] */')
lines.push('export type DialectFunction = [name: string, signature: string, overloads: number]')
lines.push('export const DIALECT_KEYWORDS: Record<string, string[]> = {')
for (const d of Object.keys(keywords).sort()) lines.push(`  ${JSON.stringify(d)}: ${JSON.stringify(keywords[d])},`)
lines.push('}')
lines.push('')
lines.push('/** Reserved subset (cannot be used as identifiers/aliases). */')
lines.push('export const DIALECT_RESERVED: Record<string, string[]> = {')
for (const d of Object.keys(reservedOnly).sort()) lines.push(`  ${JSON.stringify(d)}: ${JSON.stringify(reservedOnly[d])},`)
lines.push('}')
lines.push('')
lines.push('export const DIALECT_FUNCTIONS: Record<string, DialectFunction[]> = {')
for (const d of Object.keys(functions).sort()) lines.push(`  ${JSON.stringify(d)}: ${JSON.stringify(functions[d])},`)
lines.push('}')
writeFileSync(outFile, lines.join('\n') + '\n')

for (const d of Object.keys(keywords).sort()) {
  console.log(`${d.padEnd(12)} keywords: ${String(keywords[d].length).padStart(4)}  functions: ${String(functions[d].length).padStart(4)}`)
}
console.log(`wrote ${outFile}`)
