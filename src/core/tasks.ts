/**
 * Scheduled task rules: validation, next-run planning and due-task selection. Kept pure so the
 * scheduler can be tested without a database, timers or the file system.
 */
import type { ScheduledTask, TaskFormat, TaskInput } from '../shared/tasks'

export const TASK_FORMATS: readonly TaskFormat[] = ['csv', 'tsv', 'json', 'insert', 'xlsx']
export const MIN_INTERVAL_MINUTES = 1
/** A week: anything slower is better handled by an external cron. */
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60
export const MAX_TASKS = 200
export const MAX_TASK_SQL = 1_000_000

const EXTENSION: Record<TaskFormat, string> = { csv: 'csv', tsv: 'tsv', json: 'json', insert: 'sql', xlsx: 'xlsx' }

/** File extension written for a format (used by the save dialog's default name). */
export const taskExtension = (format: TaskFormat): string => EXTENSION[format]

/** Coerce and validate what the renderer sends; throws a message the dialog can show directly. */
export function normalizeTaskInput(raw: TaskInput): TaskInput {
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 200) : ''
  const connectionId = typeof raw.connectionId === 'string' ? raw.connectionId.trim().slice(0, 200) : ''
  const sql = typeof raw.sql === 'string' ? raw.sql.trim() : ''
  const outputPath = typeof raw.outputPath === 'string' ? raw.outputPath.trim().slice(0, 4000) : ''
  const everyMinutes = Math.round(Number(raw.everyMinutes))
  const format = TASK_FORMATS.includes(raw.format) ? raw.format : undefined
  if (!connectionId) throw new Error('Choose a data source for the task.')
  if (!sql) throw new Error('The task needs a SQL statement.')
  if (sql.length > MAX_TASK_SQL) throw new Error('The task SQL is too large (1 MB limit).')
  if (!format) throw new Error('Choose an export format.')
  if (!outputPath) throw new Error('Choose an output file for the task.')
  if (!Number.isFinite(everyMinutes) || everyMinutes < MIN_INTERVAL_MINUTES || everyMinutes > MAX_INTERVAL_MINUTES) {
    throw new Error(`The interval must be between ${MIN_INTERVAL_MINUTES} minute and ${MAX_INTERVAL_MINUTES} minutes.`)
  }
  return {
    ...(raw.id ? { id: String(raw.id).slice(0, 200) } : {}),
    name: name || 'Scheduled export',
    connectionId,
    sql,
    format,
    outputPath,
    everyMinutes,
    enabled: raw.enabled !== false,
  }
}

/**
 * Next run when saving: keep the existing plan when only the SQL or the output changed, and
 * restart the clock when the task was disabled or the interval changed.
 */
export function nextRunFor(previous: ScheduledTask | undefined, input: TaskInput, now: number): number | undefined {
  if (!input.enabled) return undefined
  if (previous?.enabled && previous.everyMinutes === input.everyMinutes && previous.nextRun && previous.nextRun > now) {
    return previous.nextRun
  }
  return now + input.everyMinutes * 60_000
}

/** Tasks whose planned time has arrived, oldest first. Disabled tasks never run. */
export function dueTasks(tasks: readonly ScheduledTask[], now: number): ScheduledTask[] {
  return tasks
    .filter((t) => t.enabled && (t.nextRun ?? 0) <= now)
    .sort((a, b) => (a.nextRun ?? 0) - (b.nextRun ?? 0))
}

/** Attach a finished run and plan the next one (failures are retried at the same interval). */
export function recordRun(task: ScheduledTask, run: ScheduledTask['lastRun'], now: number): ScheduledTask {
  return {
    ...task,
    ...(run ? { lastRun: run } : {}),
    nextRun: task.enabled ? now + task.everyMinutes * 60_000 : undefined,
  }
}

/** Load stored tasks defensively: drop entries with an unusable shape instead of failing the app. */
export function sanitizeStoredTasks(raw: unknown): ScheduledTask[] {
  if (!Array.isArray(raw)) return []
  const out: ScheduledTask[] = []
  for (const item of raw.slice(0, MAX_TASKS)) {
    if (!item || typeof item !== 'object') continue
    const t = item as Partial<ScheduledTask>
    if (typeof t.id !== 'string' || !t.id || typeof t.connectionId !== 'string' || !t.connectionId) continue
    if (typeof t.sql !== 'string' || !t.sql.trim() || typeof t.outputPath !== 'string' || !t.outputPath) continue
    if (!TASK_FORMATS.includes(t.format as TaskFormat)) continue
    const everyMinutes = Math.round(Number(t.everyMinutes))
    if (!Number.isFinite(everyMinutes) || everyMinutes < MIN_INTERVAL_MINUTES || everyMinutes > MAX_INTERVAL_MINUTES) continue
    out.push({
      id: t.id.slice(0, 200),
      name: typeof t.name === 'string' && t.name.trim() ? t.name.trim().slice(0, 200) : 'Scheduled export',
      connectionId: t.connectionId.slice(0, 200),
      sql: t.sql.slice(0, MAX_TASK_SQL),
      format: t.format as TaskFormat,
      outputPath: t.outputPath.slice(0, 4000),
      everyMinutes,
      enabled: t.enabled !== false,
      createdAt: Number.isFinite(t.createdAt) ? Number(t.createdAt) : Date.now(),
      ...(t.lastRun && typeof t.lastRun === 'object' ? { lastRun: t.lastRun } : {}),
      ...(Number.isFinite(t.nextRun) ? { nextRun: Number(t.nextRun) } : {}),
    })
  }
  return out
}
