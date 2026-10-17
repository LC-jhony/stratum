/**
 * Grid export (DataGrip "Export Data"): the CSV / TSV / Pipe / Semicolon formats come from
 * DataGrip's `csv-formats` (as-needed `"` quoting, `""` escaping, LF records) plus JSON and
 * SQL INSERTs for the active dialect. The Excel workbook is built by `xlsx.ts` and leaves
 * through the binary save channel.
 */
import { quote } from './quoting'
import type { ColumnMeta, DialectId } from './types'

export type ExportFormat = 'csv' | 'tsv' | 'pipe' | 'semicolon' | 'json' | 'insert'

/** Every format the toolbar offers: the text ones above plus the binary .xlsx workbook. */
export type ExportId = ExportFormat | 'xlsx'

export const EXPORT_FORMATS: readonly { id: ExportId; label: string; ext: string }[] = [
  { id: 'xlsx', label: 'Excel (.xlsx)', ext: 'xlsx' },
  { id: 'csv', label: 'CSV (comma-separated)', ext: 'csv' },
  { id: 'tsv', label: 'TSV (tab-separated)', ext: 'tsv' },
  { id: 'pipe', label: 'Pipe-separated', ext: 'txt' },
  { id: 'semicolon', label: 'Semicolon-separated', ext: 'csv' },
  { id: 'json', label: 'JSON', ext: 'json' },
  { id: 'insert', label: 'SQL INSERTs', ext: 'sql' },
]

const SEPARATORS: Partial<Record<ExportFormat, string>> = { csv: ',', tsv: '\t', pipe: '|', semicolon: ';' }

const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))

/** DataGrip's "as needed" quoting: quote when the value contains the separator, a quote or a line break. */
function delimited(v: string, sep: string): string {
  return v.includes(sep) || /["\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

function sqlLiteral(v: unknown, dialect: DialectId): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return `'${String(v).replace(/'/g, "''")}'`
}

/** Render rows to text. `table` names the INSERT target. */
export function exportText(columns: ColumnMeta[], rows: unknown[][], format: ExportFormat, table: string, dialect: DialectId): string {
  if (format === 'json') {
    return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, r[i] ?? null]))), null, 2)
  }
  if (format === 'insert') {
    const target = quote(dialect, table)
    const cols = columns.map((c) => quote(dialect, c.name)).join(', ')
    return rows.map((r) => `INSERT INTO ${target} (${cols}) VALUES (${r.map((v) => sqlLiteral(v, dialect)).join(', ')});`).join('\n')
  }
  const sep = SEPARATORS[format] ?? ','
  const lines = [columns.map((c) => delimited(c.name, sep)).join(sep)]
  for (const r of rows) lines.push(r.map((v) => delimited(text(v), sep)).join(sep))
  // Excel reads CSV using the legacy ANSI codepage unless a UTF-8 byte-order mark is present.
  const bom = format === 'csv' || format === 'semicolon' ? '\uFEFF' : ''
  return bom + lines.join('\n')
}
