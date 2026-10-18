import type { DatabaseModel, DialectId, RawResult } from '../../shared/types'

/** Moves SQL to a database and rows back. Knows nothing about SQL dialects. */
export interface Transport {
  open(): Promise<{ version?: string }>
  query(sql: string): Promise<RawResult>
  cancel(): Promise<void>
  close(): Promise<void>
}
export type Run = (sql: string) => Promise<RawResult>

/** Knows SQL text for one database family. Knows nothing about wire protocols. */
export interface Dialect {
  id: DialectId
  quote(identifier: string): string
  qualify(schema: string | undefined, table: string): string
  /** Returns paged SQL, or undefined if the statement cannot/should not be paged. */
  paginate(sql: string, limit: number, offset: number): string | undefined
  introspect(run: Run): Promise<Omit<DatabaseModel, 'dialect' | 'version'>>
  /** Overrides "does this statement return rows" for providers whose language is not SQL. */
  isRead?(stmt: string): boolean
}
