/** Connection safety profiles and write-statement classification (pure, shared by main and renderer). */
import type { ConnectionColor, ConnectionProfile } from '../shared/types'
import { readOnlyViolation, stripLeadingComments } from './sql'

export interface ProfilePreset {
  id: ConnectionProfile
  label: string
  color: ConnectionColor
  /** Ask before every statement that can change data, schema or permissions. */
  confirmWrites: boolean
  /** Default for new connections: dev keeps auto-commit, test/prod open an explicit transaction. */
  autoCommit: boolean
  description: string
}

/**
 * Presets after DBeaver's connection types (Dev = green, Test = yellow, Prod = red). A profile is
 * only a default: the dialog stores the concrete color and confirmation flag, so users can override
 * either without losing the label.
 */
export const PROFILE_PRESETS: Record<ConnectionProfile, ProfilePreset> = {
  dev: { id: 'dev', label: 'Development', color: 'green', confirmWrites: false, autoCommit: true, description: 'Local or shared development server. Writes run without an extra prompt and stay in auto-commit.' },
  test: { id: 'test', label: 'Test', color: 'yellow', confirmWrites: true, autoCommit: false, description: 'Staging or QA server. Every write asks for confirmation and opens a transaction you commit explicitly.' },
  prod: { id: 'prod', label: 'Production', color: 'red', confirmWrites: true, autoCommit: false, description: 'Live data. Every write asks for confirmation, the connection is marked in red and transactions must be committed explicitly.' },
}

export const PROFILE_ORDER: ConnectionProfile[] = ['dev', 'test', 'prod']

/** Swatches offered in the dialog; names map to the --vscode-charts-* variables in styles.css. */
export const CONNECTION_COLORS: ConnectionColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray']

export const COLOR_LABEL: Record<ConnectionColor, string> = {
  red: 'Red', orange: 'Orange', yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple', gray: 'Gray',
}

/** CSS color for a swatch. Falls back to the theme foreground when a theme lacks charts colors. */
export const colorVar = (color?: ConnectionColor): string | undefined => {
  switch (color) {
    case 'red': return 'var(--vscode-charts-red, #e51400)'
    case 'orange': return 'var(--vscode-charts-orange, #d18616)'
    case 'yellow': return 'var(--vscode-charts-yellow, #bf8803)'
    case 'green': return 'var(--vscode-charts-green, #388a34)'
    case 'blue': return 'var(--vscode-charts-blue, #1a85ff)'
    case 'purple': return 'var(--vscode-charts-purple, #652d90)'
    case 'gray': return 'var(--vscode-descriptionForeground, #8b8b8b)'
    default: return undefined
  }
}

/** Effective color for a data source: explicit swatch, then profile preset. */
export const connectionColor = (c?: { profile?: ConnectionProfile; color?: ConnectionColor }): ConnectionColor | undefined =>
  c?.color ?? (c?.profile ? PROFILE_PRESETS[c.profile]?.color : undefined)

/** Effective write-confirmation flag for a data source. */
export const confirmsWrites = (c?: { profile?: ConnectionProfile; confirmWrites?: boolean }): boolean =>
  c?.confirmWrites ?? (c?.profile ? PROFILE_PRESETS[c.profile]?.confirmWrites : false) ?? false

const DDL = /^\s*(create|alter|drop|truncate|rename|comment\s+on|reindex|cluster|vacuum|analyze)\b/i
const DCL = /^\s*(grant|revoke|deny)\b/i
const DML = /^\s*(insert|update|delete|merge|replace|upsert|copy|load\s+data|call|exec|execute|do|declare|begin\s+atomic)\b/i
/** CTEs that hide a write behind SELECT. */
const WRITE_ANYWHERE = /\b(insert\s+into|update\s+[A-Za-z_"`[]|delete\s+from|merge\s+into)\b/i

export type WriteKind = 'DML' | 'DDL' | 'DCL'

/** Classify a statement that can change data, schema or permissions. */
export function writeKind(sql: string): WriteKind | undefined {
  const code = stripLeadingComments(sql)
  if (!code) return undefined
  if (DCL.test(code)) return 'DCL'
  if (DDL.test(code)) return 'DDL'
  if (DML.test(code)) return 'DML'
  if (/^\s*with\b/i.test(code) && (readOnlyViolation(code) || WRITE_ANYWHERE.test(code))) return 'DML'
  return undefined
}

export const isWriteStatement = (sql: string): boolean => writeKind(sql) !== undefined

/** Short human label for the confirmation prompt. */
export const writeLabel = (kind: WriteKind): string => (kind === 'DDL' ? 'schema change' : kind === 'DCL' ? 'permission change' : 'data change')
