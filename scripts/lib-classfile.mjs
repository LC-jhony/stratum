/**
 * Minimal Java class-file reader shared by the DataGrip extraction scripts.
 *
 * Reads the constant pool of a `.class` file and returns every UTF-8 entry. It is enough to
 * recover string constants (keyword arrays, SQL catalog queries) without a JVM decompiler.
 */
import { readFileSync } from 'node:fs'

/** Return every UTF-8 constant from a class file (runs without a JVM). */
export function classUtf8(file) {
  const buf = readFileSync(file)
  if (buf.readUInt32BE(0) !== 0xcafebabe) return []
  let o = 8
  const count = buf.readUInt16BE(o); o += 2
  const out = []
  for (let i = 1; i < count; i++) {
    const tag = buf[o++]
    switch (tag) {
      case 1: { const len = buf.readUInt16BE(o); o += 2; out.push(buf.toString('utf8', o, o + len)); o += len; break }
      case 3: case 4: o += 4; break
      case 5: case 6: o += 8; i++ // long/double take two constant slots
      case 7: case 8: case 16: case 19: case 20: o += 2; break
      case 15: o += 3; break
      case 9: case 10: case 11: case 12: case 17: case 18: o += 4; break
      default: throw new Error(`unknown constant tag ${tag} at offset ${o - 1}`)
    }
  }
  return out
}
