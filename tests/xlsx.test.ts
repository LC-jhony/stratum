import { describe, expect, it } from 'vitest'
import { bytesToBase64, colRef, crc32, exportXlsx, sheetName, sheetXml } from '../src/shared/xlsx'
import type { ColumnMeta } from '../src/shared/types'

const enc = new TextEncoder(), dec = new TextDecoder()

/** Read a store-only ZIP back, verifying each entry's CRC like a real unzip would. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = bytes.length - 22
  while (v.getUint32(eocd, true) !== 0x06054b50) eocd--
  const count = v.getUint16(eocd + 10, true), cd = v.getUint32(eocd + 16, true)
  const out = new Map<string, string>()
  let p = cd
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50)
    const crc = v.getUint32(p + 16, true), size = v.getUint32(p + 20, true)
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true)
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen))
    const at = v.getUint32(p + 42, true)
    expect(v.getUint32(at, true)).toBe(0x04034b50)
    const start = at + 30 + v.getUint16(at + 26, true) + v.getUint16(at + 28, true)
    const data = bytes.subarray(start, start + size)
    expect(crc32(data)).toBe(crc)
    out.set(name, dec.decode(data))
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

describe('crc32 / column refs / sheet names', () => {
  it('matches the classic CRC-32 check value', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array())).toBe(0)
  })
  it('writes A1 column refs past Z', () => {
    expect([colRef(0), colRef(25), colRef(26), colRef(27), colRef(701), colRef(702)]).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA'])
  })
  it('sanitizes sheet names for Excel', () => {
    expect(sheetName('public.orders')).toBe('public.orders')
    expect(sheetName("weird[]:*?/\\'name")).toBe('weirdname')
    expect(sheetName('x'.repeat(40))).toHaveLength(31)
    expect(sheetName('')).toBe('result')
  })
})

const columns: ColumnMeta[] = [{ name: 'id' }, { name: 'name' }, { name: 'ok' }, { name: 'notes' }]
const rows = [[1, 'Ada & <Bob>', true, null], [2, 'a\u0000b', false, 'line1\nline2']]

describe('xlsx export', () => {
  it('packs a valid OOXML package: PK signature, expected parts, verified CRCs', () => {
    const bytes = exportXlsx(columns, rows)
    expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(0x04034b50) // "PK\x03\x04"
    const files = unzip(bytes)
    expect([...files.keys()]).toEqual([
      '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml',
    ])
    expect(files.get('[Content_Types].xml')).toContain('spreadsheetml.sheet.main+xml')
    expect(files.get('xl/workbook.xml')).toContain('<sheet name="result" sheetId="1" r:id="rId1"/>')
  })

  it('writes a bold frozen header and typed cells', () => {
    const xml = sheetXml(columns, rows)
    expect(xml).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>')
    expect(xml).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">id</t></is></c>')
    expect(xml).toContain('<c r="A2"><v>1</v></c>')          // number stays a number
    expect(xml).toContain('<c r="C2" t="b"><v>1</v></c>')    // boolean
    expect(xml).toContain('<c r="C3" t="b"><v>0</v></c>')
    expect(xml).toContain('<c r="D2"/>')                     // null is an empty cell
  })

  it('escapes XML and strips characters XML forbids', () => {
    const xml = sheetXml(columns, rows)
    expect(xml).toContain('Ada &amp; &lt;Bob&gt;')
    expect(xml).toContain('>ab<')                            // \x00 removed
    expect(xml).toContain('line1\nline2')
  })

  it('names the sheet after the table, sanitized', () => {
    const files = unzip(exportXlsx(columns, rows, 'sales/2024'))
    expect(files.get('xl/workbook.xml')).toContain('<sheet name="sales2024"')
  })

  it('round-trips through the base64 channel', () => {
    const bytes = exportXlsx(columns, rows)
    expect(new Uint8Array(Buffer.from(bytesToBase64(bytes), 'base64'))).toEqual(bytes)
  })
})
