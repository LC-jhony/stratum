/**
 * Minimal .xlsx writer (Office Open XML, ECMA-376): a single sheet with typed cells, a bold
 * frozen header row and auto-ish column widths, packed as a store-only ZIP. Zero dependencies,
 * so the same code runs in the renderer and in tests. The export flow hands the bytes to the
 * binary save dialog (see ExportMenu).
 */
import type { ColumnMeta } from './types'

const enc = new TextEncoder()

/* ---------- CRC-32 ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()

/** CRC-32 as used by ZIP entries. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/* ---------- ZIP container (store, no compression) ---------- */

/** Fixed DOS stamp (2020-01-01) so exports are deterministic. */
const DOS_DATE = 20513

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

function localHeader(name: Uint8Array, data: Uint8Array, crc: number): Uint8Array {
  const b = new Uint8Array(30 + name.length + data.length), v = new DataView(b.buffer)
  v.setUint32(0, 0x04034b50, true)
  v.setUint16(4, 20, true)      // version needed
  v.setUint16(6, 0x0800, true)  // UTF-8 file names
  v.setUint16(8, 0, true)       // method: store
  v.setUint16(10, 0, true); v.setUint16(12, DOS_DATE, true)
  v.setUint32(14, crc, true)
  v.setUint32(18, data.length, true); v.setUint32(22, data.length, true)
  v.setUint16(26, name.length, true); v.setUint16(28, 0, true)
  b.set(name, 30); b.set(data, 30 + name.length)
  return b
}

function centralHeader(name: Uint8Array, size: number, crc: number, offset: number): Uint8Array {
  const b = new Uint8Array(46 + name.length), v = new DataView(b.buffer)
  v.setUint32(0, 0x02014b50, true)
  v.setUint16(4, 20, true); v.setUint16(6, 20, true)
  v.setUint16(8, 0x0800, true)  // UTF-8 file names
  v.setUint16(10, 0, true)      // method: store
  v.setUint16(12, 0, true); v.setUint16(14, DOS_DATE, true)
  v.setUint32(16, crc, true)
  v.setUint32(20, size, true); v.setUint32(24, size, true)
  v.setUint16(28, name.length, true)
  v.setUint32(42, offset, true)
  b.set(name, 46)
  return b
}

function zipStore(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const locals: Uint8Array[] = [], dir: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const name = enc.encode(e.name), crc = crc32(e.data), l = localHeader(name, e.data, crc)
    locals.push(l); dir.push(centralHeader(name, e.data.length, crc, offset)); offset += l.length
  }
  const cd = concat(dir), end = new Uint8Array(22), v = new DataView(end.buffer)
  v.setUint32(0, 0x06054b50, true)
  v.setUint16(8, entries.length, true); v.setUint16(10, entries.length, true)
  v.setUint32(12, cd.length, true); v.setUint32(16, offset, true)
  return concat([...locals, cd, end])
}

/* ---------- XML ---------- */

/** Characters XML 1.0 forbids even escaped; database text carries them now and then. */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g
const esc = (s: string) => s.replace(CONTROL, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Column reference in A1 notation (A..Z, AA..ZZ, AAA..). */
export function colRef(n: number): string {
  let s = ''
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** Excel sheet names: no []:*?/\', at most 31 chars, never empty. */
export function sheetName(table: string): string {
  const s = table.replace(/[\[\]:*?\/\\']/g, '').trim().slice(0, 31)
  return s || 'result'
}

const cell = (ref: string, v: unknown, style = ''): string => {
  if (v === null || v === undefined) return `<c r="${ref}"${style}/>`
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`
  if (typeof v === 'boolean') return `<c r="${ref}"${style} t="b"><v>${v ? 1 : 0}</v></c>`
  const t = typeof v === 'string' ? v : String(v)
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(t)}</t></is></c>`
}

const width = (columns: ColumnMeta[], rows: unknown[][], i: number): number => {
  let m = columns[i].name.length
  for (let r = 0; r < Math.min(rows.length, 200); r++) m = Math.max(m, String(rows[r]?.[i] ?? '').length)
  return Math.min(Math.max(m + 2, 8), 60)
}

/** Worksheet XML: bold frozen header, then one typed cell per grid value. */
export function sheetXml(columns: ColumnMeta[], rows: unknown[][]): string {
  const head = `<row r="1">${columns.map((c, i) => cell(`${colRef(i)}1`, c.name, ' s="1"')).join('')}</row>`
  const body = rows.map((r, i) => `<row r="${i + 2}">${columns.map((_c, j) => cell(`${colRef(j)}${i + 2}`, r[j])).join('')}</row>`).join('')
  const cols = columns.map((_c, i) => `<col min="${i + 1}" max="${i + 1}" width="${width(columns, rows, i)}" customWidth="1"/>`).join('')
  const last = `${colRef(Math.max(0, columns.length - 1))}${rows.length + 1}`
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<dimension ref="A1:${last}"/>`
    + `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="15"/>`
    + (cols ? `<cols>${cols}</cols>` : '')
    + `<sheetData>${head}${body}</sheetData>`
    + `</worksheet>`
}

/* ---------- Package parts ---------- */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

const CONTENT_TYPES = XML_HEAD
  + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
  + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
  + `<Default Extension="xml" ContentType="application/xml"/>`
  + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
  + `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
  + `</Types>`

const PACKAGE_RELS = XML_HEAD
  + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
  + `</Relationships>`

const WORKBOOK_RELS = XML_HEAD
  + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>`
  + `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
  + `</Relationships>`

/** Regular font + bold font; cell style 1 is the bold header. */
const STYLES = XML_HEAD
  + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>`
  + `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>`
  + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
  + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
  + `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>`
  + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>`
  + `</styleSheet>`

const workbook = (name: string) => XML_HEAD
  + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
  + `<sheets><sheet name="${esc(name)}" sheetId="1" r:id="rId1"/></sheets>`
  + `</workbook>`

/** Build a one-sheet workbook. `table` names the sheet. */
export function exportXlsx(columns: ColumnMeta[], rows: unknown[][], table = 'result'): Uint8Array {
  return zipStore([
    { name: '[Content_Types].xml', data: enc.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: enc.encode(PACKAGE_RELS) },
    { name: 'xl/workbook.xml', data: enc.encode(workbook(sheetName(table))) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(WORKBOOK_RELS) },
    { name: 'xl/styles.xml', data: enc.encode(STYLES) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheetXml(columns, rows)) },
  ])
}

/** Base64 for the IPC binary channel, chunked so huge grids cannot blow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
