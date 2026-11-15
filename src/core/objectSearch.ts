/** Cross-connection object search over the introspected models already loaded in the renderer. */
import type { DriverKind } from '../shared/types'

export interface SearchableTable { name: string; kind: 'table' | 'view'; columns: { name: string; dataType?: string }[] }
export interface SearchableSchema { name: string; tables: SearchableTable[] }
export interface SearchableConnection {
  id: string
  name: string
  kind?: DriverKind
  model?: { schemas: SearchableSchema[] }
}

export interface ObjectHit {
  connectionId: string
  connectionName: string
  schema: string
  table: string
  kind: 'table' | 'view'
  /** Present when the match came from a column. */
  column?: string
  columnType?: string
  match: 'table' | 'column' | 'schema' | 'connection'
  score: number
}

const norm = (s: string) => s.toLowerCase()

/** Score one candidate name against the query (higher is better, 0 = no match). */
function scoreName(name: string, query: string, base: number): number {
  const n = norm(name), q = norm(query)
  if (!q) return 0
  if (n === q) return base + 40
  if (n.startsWith(q)) return base + 25
  if (n.includes(q)) return base + 10
  return 0
}

/**
 * Find tables, views and columns across every loaded model. A dotted query scopes the search:
 * `schema.table` matches a schema + table, `table.column` matches a table's column. Plain text
 * matches names, schemas and connections. Results are stable: best score first, then names.
 */
export function searchObjects(connections: SearchableConnection[], query: string, limit = 200): ObjectHit[] {
  const q = query.trim()
  if (!q) return []
  const dot = q.indexOf('.')
  const head = dot > 0 ? q.slice(0, dot) : undefined
  const tail = dot > 0 ? q.slice(dot + 1) : q
  const hits: ObjectHit[] = []

  for (const c of connections) {
    if (!head) {
      const connScore = scoreName(c.name, q, 0)
      if (connScore) hits.push({ connectionId: c.id, connectionName: c.name, schema: '', table: c.name, kind: 'table', match: 'connection', score: connScore })
    }
    for (const s of c.model?.schemas ?? []) {
      const schemaScore = head ? scoreName(s.name, head, 0) : 0
      for (const t of s.tables) {
        const base = { connectionId: c.id, connectionName: c.name, schema: s.name, table: t.name, kind: t.kind }
        if (!head) {
          const tableScore = scoreName(t.name, q, 60)
          if (tableScore) hits.push({ ...base, match: 'table', score: tableScore })
          for (const col of t.columns) {
            const colScore = scoreName(col.name, q, 20)
            if (colScore) hits.push({ ...base, column: col.name, columnType: col.dataType, match: 'column', score: colScore })
          }
          continue
        }
        // Dotted query: schema.table…
        const bySchemaTable = schemaScore ? scoreName(t.name, tail, 50) : 0
        if (bySchemaTable) hits.push({ ...base, match: 'table', score: bySchemaTable + schemaScore + 10 })
        // Dotted query: table.column…
        const tableHead = scoreName(t.name, head, 50)
        if (tableHead) {
          for (const col of t.columns) {
            const colScore = scoreName(col.name, tail, 20)
            if (colScore) hits.push({ ...base, column: col.name, columnType: col.dataType, match: 'column', score: colScore + tableHead })
          }
        }
      }
    }
  }

  const seen = new Set<string>()
  return hits
    .sort((a, b) => b.score - a.score || a.connectionName.localeCompare(b.connectionName) || a.schema.localeCompare(b.schema) || a.table.localeCompare(b.table) || (a.column ?? '').localeCompare(b.column ?? ''))
    .filter((h) => {
      const key = `${h.connectionId}\u0000${h.schema}\u0000${h.table}\u0000${h.column ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, limit)
}
