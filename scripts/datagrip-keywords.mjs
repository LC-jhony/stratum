#!/usr/bin/env node
/**
 * Extract SQL keyword catalogs from DataGrip dialect class files.
 *
 * Provenance: built against DataGrip 2026.2.6 (build DB-262.10968.148, snap revision 312).
 * Input: a directory produced by extracting `*Keywords.class` from the module jars
 * `plugins/DatabaseTools/lib/modules/intellij.database.dialects.*.jar`
 * (e.g. `unzip -j jar '*Keywords.class' -d out/<jar>`).
 *
 * The keyword arrays are plain Java string constants, so the shared constant-pool
 * reader (lib-classfile.mjs) recovers them without a JVM decompiler. Output is JSON on stdout:
 * { "<dialect>": { reserved: string[], optional: string[] } }
 *
 * Usage: node scripts/datagrip-keywords.mjs <classes-dir>
 */
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { classUtf8 } from './lib-classfile.mjs'

const root = process.argv[2]
if (!root) {
  console.error('usage: node scripts/datagrip-keywords.mjs <classes-dir>')
  process.exit(2)
}

const result = {}
for (const dir of readdirSync(root)) {
  const full = path.join(root, dir)
  if (!statSync(full).isDirectory()) continue
  const entry = {}
  for (const f of readdirSync(full)) {
    if (!f.endsWith('.class')) continue
    const words = classUtf8(path.join(full, f)).filter((s) => /^[A-Z][A-Z0-9_ -]{0,}$/.test(s))
    // Several classes per dialect dir (e.g. Oracle: Reserved + Pl + Plus): accumulate, never overwrite.
    if (/reserved/i.test(f)) entry.reserved = [...(entry.reserved ?? []), ...words]
    else if (/optional/i.test(f)) entry.optional = [...(entry.optional ?? []), ...words]
  }
  result[dir.replace(/^intellij\.database\.dialects\./, '')] = entry
}
console.log(JSON.stringify(result))
