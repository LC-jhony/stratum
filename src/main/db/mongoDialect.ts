import type { ColumnInfo, ConnectionConfig, DatabaseModel, IndexInfo, SchemaInfo, TableInfo } from '../../shared/types'
import type { Dialect, Run } from './types'
import { isMongoRead, paginateMongoStatement } from './transports/mongodb'

/**
 * Mongo "dialect": introspection builds the same schemas/tables/columns model the Explorer already
 * renders — databases become schemas, collections become tables (views keep their kind), sampled
 * document fields become columns and listIndexes fills the index rows. Paging and read detection
 * delegate to the statement parser in transports/mongodb.ts.
 *
 * Field sampling is capped (docs per collection, databases, collections, total time) because
 * introspection runs on every connect/refresh; system databases (admin/config/local) list their
 * collections but are not sampled — local.oplog.rs documents are not worth the latency.
 */

const SAMPLE_DOCS = 25
const MAX_FIELDS = 200
const MAX_DATABASES = 25
const MAX_COLLECTIONS = 300
const TIME_BUDGET_MS = 15_000
const NO_SAMPLE = new Set(['admin', 'config', 'local'])

type Doc = Record<string, unknown>
const one = async (run: Run, stmt: string): Promise<Doc> => {
  const r = await run(stmt)
  return Object.fromEntries(r.columns.map((c, i) => [c.name, r.rows[0]?.[i]]))
}
/** A find result carries one row per document; rebuild the documents for field typing. */
const docsFrom = (r: { columns: { name: string }[]; rows: unknown[][] }): Doc[] =>
  r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name, row[i]])))
const batch = (resp: Doc): Doc[] => {
  const cursor = resp.cursor as { firstBatch?: Doc[] } | undefined
  const list = cursor?.firstBatch ?? resp
  return Array.isArray(list) ? (list as Doc[]) : []
}
const typeName = (v: unknown): string => {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return 'array'
  if (v instanceof Date) return 'date'
  if (typeof v === 'object') return 'object'
  return typeof v
}

export function createMongoDialect(cfg: ConnectionConfig): Dialect {
  const defaultDb = cfg.database || 'test'
  const sibling = (name: string) => `db.getSiblingDB(${JSON.stringify(name)})`

  const columnsOf = (docs: Doc[]): ColumnInfo[] => {
    const types = new Map<string, string>()
    for (const d of docs) {
      for (const [k, v] of Object.entries(d)) {
        if (types.size >= MAX_FIELDS && !types.has(k)) continue
        const known = types.get(k)
        if (known === undefined || (known === 'null' && v !== null)) types.set(k, typeName(v))
      }
    }
    if (types.has('_id')) { const t = types.get('_id')!; types.delete('_id'); types.set('_id', t) }
    return [...types].map(([name, dataType], i) => ({ name, dataType, nullable: name !== '_id', default: null, isPrimaryKey: name === '_id', ordinal: i + 1 }))
  }

  const indexesOf = async (run: Run, db: string, coll: string): Promise<IndexInfo[]> => {
    try {
      const rows = batch(await one(run, `${sibling(db)}.runCommand({ listIndexes: ${JSON.stringify(coll)} })`))
      return rows.map((i) => ({
        name: String(i.name ?? ''),
        columns: Object.keys((i.key ?? {}) as Doc),
        unique: i.unique === true || i.name === '_id_',
      }))
    } catch { return [] }
  }

  const collectionsOf = async (run: Run, db: string, deadline: number): Promise<TableInfo[]> => {
    const rows = batch(await one(run, `${sibling(db)}.runCommand({ listCollections: 1, nameOnly: true })`))
    const tables: TableInfo[] = []
    for (const c of rows.slice(0, MAX_COLLECTIONS)) {
      const name = String(c.name ?? '')
      if (!name || name.startsWith('system.')) continue // system.views / system.buckets are not user data
      let docs: Doc[] = []
      if (!NO_SAMPLE.has(db) && Date.now() < deadline) {
        try { docs = docsFrom(await run(`${sibling(db)}.getCollection(${JSON.stringify(name)}).find({}).limit(${SAMPLE_DOCS})`)) } catch { docs = [] }
      }
      tables.push({ name, kind: c.type === 'view' ? 'view' : 'table', columns: columnsOf(docs), foreignKeys: [], indexes: await indexesOf(run, db, name) })
    }
    return tables.sort((a, b) => a.name.localeCompare(b.name))
  }

  return {
    // Mongo has no SQL text: these only exist to satisfy the shared Dialect contract and are
    // unreachable while the UI hides SQL affordances for non-SQL kinds.
    id: 'generic',
    quote: (id) => id,
    qualify: (schema, table) => (schema ? `${schema}.${table}` : table),
    paginate: paginateMongoStatement,
    isRead: isMongoRead,
    async introspect(run): Promise<Omit<DatabaseModel, 'dialect' | 'version'>> {
      let names: string[]
      try {
        const resp = await one(run, 'db.adminCommand({ listDatabases: 1 })')
        names = ((resp.databases as Doc[] | undefined) ?? []).map((d) => String(d.name ?? '')).filter(Boolean)
      } catch {
        names = [] // listDatabases needs admin privileges; fall back to the connected database.
      }
      if (!names.includes(defaultDb)) names.unshift(defaultDb)
      const chosen = names.slice(0, MAX_DATABASES)
      const deadline = Date.now() + TIME_BUDGET_MS
      const schemas: SchemaInfo[] = []
      for (const name of chosen) {
        try { schemas.push({ name, tables: await collectionsOf(run, name, deadline) }) }
        catch { schemas.push({ name, tables: [] }) } // no permission / dropped mid-run: keep the database node
      }
      return { kind: 'mongodb', schemas: schemas.sort((a, b) => a.name.localeCompare(b.name)) }
    },
  }
}
