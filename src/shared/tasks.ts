/** Scheduled server tasks (recurring exports) and their persisted state. */

/** File formats a scheduled export can write. */
export type TaskFormat = 'csv' | 'tsv' | 'json' | 'insert' | 'xlsx'

/** Result of the last execution of a task. */
export interface TaskRun {
  /** Epoch milliseconds when the run finished. */
  at: number
  ok: boolean
  /** Error text on failure, or a short summary on success. */
  message: string
  rows?: number
  /** File written by the run, when it succeeded. */
  file?: string
}

export interface ScheduledTask {
  id: string
  name: string
  connectionId: string
  /** One SELECT (or any statement returning rows). */
  sql: string
  format: TaskFormat
  /** Absolute file chosen by the user; overwritten on every run. */
  outputPath: string
  /** Interval between runs, in minutes (1 minute .. 7 days). */
  everyMinutes: number
  enabled: boolean
  /** Epoch milliseconds when the task was created. */
  createdAt: number
  lastRun?: TaskRun
  /** Epoch milliseconds of the next planned run; absent when disabled. */
  nextRun?: number
}

/** Fields the UI sends when creating or editing a task. */
export interface TaskInput {
  id?: string
  name: string
  connectionId: string
  sql: string
  format: TaskFormat
  outputPath: string
  everyMinutes: number
  enabled: boolean
}
