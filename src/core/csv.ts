/** RFC 4180 CSV/TSV parsing with delimiter sniffing, used by the data import dialog. Pure and dependency-free. */

export interface CsvOptions {
  /** Explicit delimiter; otherwise sniffed from the first lines. */
  delimiter?: string
  /** First row is the header (default true). */
  hasHeader?: boolean
}

export interface CsvTable {
  /** Delimiter used to split the text: `,` `;` `\t` or `|`. */
  delimiter: string
  headers: string[]
  rows: string[][]
}

const CANDIDATES = [',', ';', '\t', '|'] as const

/** Count a delimiter outside quotes; ties prefer the earlier candidate (comma first). */
function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0, quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { i++; continue }
      quoted = !quoted
    } else if (ch === delimiter && !quoted) count++
  }
  return count
}

/**
 * Pick the delimiter with the most occurrences across the first non-empty lines. The first line
 * decides when it contains any candidate; otherwise the next lines are scanned, so files that
 * start with a comment or a title row still work.
 */
export function detectDelimiter(text: string): string {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 5)
  if (!lines.length) return ','
  for (const line of lines) {
    let best = ',', bestCount = 0
    for (const d of CANDIDATES) {
      const n = countOutsideQuotes(line, d)
      if (n > bestCount) { best = d; bestCount = n }
    }
    if (bestCount > 0) return best
  }
  return ','
}

/** Split the text into records. Unquoted CR/LF end a record; `""` is a literal quote. */
function parseRecords(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false, i = 0
  const push = () => { row.push(field); field = '' }
  while (i < text.length) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false; i++; continue
      }
      field += ch; i++; continue
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue }
    if (ch === delimiter) { push(); i++; continue }
    if (ch === '\r') { i++; continue }
    if (ch === '\n') { push(); rows.push(row); row = []; i++; continue }
    field += ch; i++
  }
  if (field !== '' || row.length) { push(); rows.push(row) }
  return rows.filter((r) => r.length > 1 || r[0] !== '')
}

/**
 * Parse delimited text into headers and rows. Rows are padded to the widest record so every row
 * has one cell per header; short headers are filled with `column_N`. A BOM is stripped.
 */
export function parseCsv(text: string, opts: CsvOptions = {}): CsvTable {
  const source = text.replace(/^\uFEFF/, '')
  const delimiter = opts.delimiter ?? detectDelimiter(source)
  const records = parseRecords(source, delimiter)
  const hasHeader = opts.hasHeader ?? true
  const width = records.reduce((n, r) => Math.max(n, r.length), 0)
  const headerRow = hasHeader ? records.shift() ?? [] : []
  const headers = Array.from({ length: width }, (_v, i) => (headerRow[i] ?? '').trim() || `column_${i + 1}`)
  const rows = records.map((r) => Array.from({ length: width }, (_v, i) => r[i] ?? ''))
  return { delimiter, headers, rows }
}

/**
 * Align parsed rows with the target table's columns. Headers are matched by name (case-insensitive);
 * a column the file does not provide becomes NULL rather than an empty string, which a typed column
 * would reject. Files whose headers match nothing fall back to positional mapping.
 */
export function projectRows(table: CsvTable, columns: string[]): (string | null)[][] {
  const at = new Map(table.headers.map((h, i) => [h.trim().toLowerCase(), i]))
  const matched = columns.map((c) => at.get(c.trim().toLowerCase()))
  if (!matched.some((i) => i !== undefined)) {
    return table.rows.map((r) => columns.map((_c, i) => r[i] ?? null))
  }
  return table.rows.map((r) => matched.map((i) => (i === undefined ? null : r[i] ?? null)))
}
