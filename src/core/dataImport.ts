/**
 * Data import model: turn a file (CSV/TSV/JSON/XLSX) or a copied result into the column mapping and
 * INSERT statements the import dialog previews and submits. Pure except for the XLSX reader.
 */
import { parseCsv } from './csv'
import { quote } from './quoting'
import { literalFor } from './sqlgen'
import * as XLSX from 'xlsx'
import type { DialectId } from '../shared/types'

export type ImportValue = string | number | boolean | null
export interface TabularData { headers: string[]; rows: ImportValue[][] }
export interface XlsxSheet extends TabularData { name: string }

const text = (v: unknown): ImportValue => {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** CSV/TSV for import: an empty field means NULL, unlike an explicit `""`. */
export function csvTable(content: string): TabularData {
  const table = parseCsv(content)
  return { headers: table.headers, rows: table.rows.map((r) => r.map((v) => (v === '' ? null : v))) }
}

/** JSON array of objects (a single object, or `{ data: [...] }`, is accepted too). */
export function jsonTable(content: string): TabularData {
  let parsed: unknown
  try { parsed = JSON.parse(content) } catch { throw new Error('The JSON file is not valid.') }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { data?: unknown })?.data)
      ? (parsed as { data: unknown[] }).data
      : parsed && typeof parsed === 'object' ? [parsed] : []
  const objects = list.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r))
  if (!objects.length) return { headers: [], rows: [] }
  const headers: string[] = []
  for (const row of objects) for (const key of Object.keys(row)) if (!headers.includes(key)) headers.push(key)
  return { headers, rows: objects.map((row) => headers.map((h) => text(row[h]))) }
}

/** Every sheet of an XLSX workbook, first row as headers. Dates become ISO strings. */
export function xlsxTables(base64: string): XlsxSheet[] {
  const book = XLSX.read(base64, { type: 'base64', cellDates: true })
  return book.SheetNames.map((name) => {
    const grid = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false })
    const width = grid.reduce((n, row) => Math.max(n, row.length), 0)
    const headerRow = grid.shift() ?? []
    const headers = Array.from({ length: width }, (_v, i) => String(headerRow[i] ?? '').trim() || `column_${i + 1}`)
    const rows = grid.map((row) => headers.map((_h, i) => text(row[i])))
    return { name, headers, rows }
  })
}

/** Default mapping: target columns matched to same-named source headers, case-insensitively. */
export function autoMapping(headers: string[], columns: string[]): (string | null)[] {
  const byName = new Map(headers.map((h) => [h.trim().toLowerCase(), h]))
  return columns.map((c) => byName.get(c.trim().toLowerCase()) ?? null)
}

export interface InsertInput {
  /** Quoted, schema-qualified target table. */
  target: string
  dialect: DialectId
  /** Target columns, in the order their source values appear in `rows`. */
  columns: string[]
  rows: readonly ImportValue[][]
}

/**
 * Multi-row INSERTs in blocks of `chunk` rows. Values already come in target-column order; the
 * caller filters unmapped columns out before calling this.
 */
export function insertStatements(input: InsertInput, chunk = 200): string[] {
  const q = (c: string) => quote(input.dialect, c)
  const lit = literalFor(input.dialect)
  const cols = input.columns.map(q).join(', ')
  const out: string[] = []
  for (let start = 0; start < input.rows.length; start += chunk) {
    const rows = input.rows.slice(start, start + chunk)
    if (!rows.length) continue
    const values = rows.map((row) => `(${row.map(lit).join(', ')})`).join(',\n  ')
    out.push(`INSERT INTO ${input.target} (${cols}) VALUES\n  ${values}`)
  }
  return out
}

/** Target columns after mapping: `sourceIndex` is null when the user skipped the column. */
export interface ColumnMap { column: string; sourceIndex: number | null }

export function mappedRows(source: TabularData, map: readonly ColumnMap[]): ImportValue[][] {
  const used = map.filter((m) => m.sourceIndex !== null)
  return source.rows.map((row) => used.map((m) => row[m.sourceIndex!] ?? null))
}
