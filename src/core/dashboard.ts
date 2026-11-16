/**
 * Server dashboard helpers: per-dialect size/session queries and model statistics. Pure, so the
 * queries and the numbers shown next to each data source can be tested without a server.
 */
import type { DatabaseModel, DialectId } from '../shared/types'

export interface DashboardQuery {
  id: 'size' | 'sessions'
  label: string
  sql: string
}

/** Queries that work on the three first-class engines; other dialects simply show no metrics. */
export function dashboardQueries(dialect: DialectId): DashboardQuery[] {
  switch (dialect) {
    case 'postgres':
    case 'greenplum':
    case 'redshift':
      return [
        { id: 'size', label: 'Database size', sql: 'select pg_database_size(current_database()) as bytes' },
        { id: 'sessions', label: 'Sessions', sql: 'select count(*) as sessions from pg_stat_activity where datname = current_database()' },
      ]
    case 'mysql':
    case 'mariadb':
      return [
        { id: 'size', label: 'Data + indexes', sql: 'select coalesce(sum(data_length + index_length), 0) as bytes from information_schema.tables where table_schema = database()' },
        { id: 'sessions', label: 'Sessions', sql: 'select count(*) as sessions from information_schema.processlist' },
      ]
    case 'sqlite':
      return [
        { id: 'size', label: 'File size', sql: 'select (select page_count from pragma_page_count()) * (select page_size from pragma_page_size()) as bytes' },
      ]
    default:
      return []
  }
}

/** Read a numeric metric from a one-row result, tolerating driver strings (bigint as text). */
export function metricValue(columns: { name: string }[], rows: unknown[][], column: string): number | undefined {
  const index = columns.findIndex((c) => c.name.toLowerCase() === column)
  if (index < 0 || !rows.length) return undefined
  const raw = rows[0][index]
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/** Human byte count; undefined when the size is unknown. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes / 1024, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export interface ModelStats {
  schemas: number
  tables: number
  views: number
  columns: number
  foreignKeys: number
}

/** Counts shown on each dashboard card, derived from the already-introspected model. */
export function modelStats(model: DatabaseModel | undefined): ModelStats {
  const stats: ModelStats = { schemas: 0, tables: 0, views: 0, columns: 0, foreignKeys: 0 }
  for (const schema of model?.schemas ?? []) {
    stats.schemas++
    for (const table of schema.tables) {
      if (table.kind === 'view') stats.views++
      else stats.tables++
      stats.columns += table.columns.length
      stats.foreignKeys += table.foreignKeys.length
    }
  }
  return stats
}
