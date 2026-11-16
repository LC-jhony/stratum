import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { exportText, type ExportFormat } from '../../core/export'
import { dueTasks, MAX_TASKS, normalizeTaskInput, nextRunFor, recordRun, sanitizeStoredTasks } from '../../core/tasks'
import { exportXlsx } from '../../core/xlsx'
import type { ScheduledTask, TaskInput, TaskRun } from '../../shared/tasks'
import type { ColumnMeta, DialectId } from '../../shared/types'
import { logger } from '../logger'
import type { ConnectionManager } from './connectionManager'
import { JsonStore } from './store'

/** Rows a scheduled export may collect before the task fails instead of exhausting memory. */
export const MAX_EXPORT_ROWS = 1_000_000
const PAGE = 5000

interface TaskFile { tasks: ScheduledTask[] }

/**
 * Recurring exports. Tasks live in <userData>/tasks.json; the timer checks once per interval and
 * runs due tasks one at a time through the normal session stack (SSH tunnel, SSL, paging included).
 * The output file is overwritten atomically so a failed run never leaves a half-written export.
 */
export class TaskService {
  private store: JsonStore<TaskFile>
  private timer?: ReturnType<typeof setInterval>
  private running = new Set<string>()
  /** Serializes reads/writes of tasks.json; SQL execution stays inside the queue to keep ordering. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    file: string,
    private manager: ConnectionManager,
    private opts: { onChanged?: (tasks: ScheduledTask[]) => void; tickMs?: number } = {},
  ) {
    this.store = new JsonStore<TaskFile>(file, { tasks: [] })
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async raw(): Promise<ScheduledTask[]> {
    return sanitizeStoredTasks((await this.store.read()).tasks)
  }

  private async persist(tasks: ScheduledTask[]): Promise<ScheduledTask[]> {
    await this.store.write({ tasks })
    this.opts.onChanged?.(tasks)
    return tasks
  }

  list(): Promise<ScheduledTask[]> {
    return this.serial(async () => {
      const tasks = await this.raw()
      return [...tasks].sort((a, b) => (a.nextRun ?? Number.MAX_SAFE_INTEGER) - (b.nextRun ?? Number.MAX_SAFE_INTEGER))
    })
  }

  save(input: TaskInput): Promise<ScheduledTask[]> {
    return this.serial(async () => {
      const clean = normalizeTaskInput(input)
      const tasks = await this.raw()
      const index = clean.id ? tasks.findIndex((t) => t.id === clean.id) : -1
      const previous = index >= 0 ? tasks[index] : undefined
      if (index < 0 && tasks.length >= MAX_TASKS) throw new Error(`There are already ${MAX_TASKS} scheduled tasks.`)
      const now = Date.now()
      const task: ScheduledTask = {
        id: previous?.id ?? clean.id ?? randomUUID(),
        name: clean.name,
        connectionId: clean.connectionId,
        sql: clean.sql,
        format: clean.format,
        outputPath: clean.outputPath,
        everyMinutes: clean.everyMinutes,
        enabled: clean.enabled,
        createdAt: previous?.createdAt ?? now,
        ...(previous?.lastRun ? { lastRun: previous.lastRun } : {}),
        nextRun: nextRunFor(previous, clean, now),
      }
      const next = index >= 0 ? tasks.map((t, i) => (i === index ? task : t)) : [...tasks, task]
      return this.persist(next)
    })
  }

  remove(id: string): Promise<ScheduledTask[]> {
    return this.serial(async () => this.persist((await this.raw()).filter((t) => t.id !== id)))
  }

  /** Run immediately without changing the planned schedule (last run and next run are still updated). */
  runNow(id: string): Promise<ScheduledTask[]> {
    return this.serial(async () => {
      const task = (await this.raw()).find((t) => t.id === id)
      if (!task) throw new Error('The scheduled task no longer exists.')
      if (this.running.has(id)) throw new Error('The task is already running.')
      await this.run(task)
      return this.listNow()
    })
  }

  /** Start the timer; tasks that became due while the app was closed run on the first check. */
  start(): void {
    if (this.timer) return
    const interval = this.opts.tickMs ?? 30_000
    this.timer = setInterval(() => void this.note(this.tick()), interval)
    this.timer.unref?.()
    void this.note(this.tick())
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private note(p: Promise<unknown>): Promise<unknown> {
    return p.catch((e: unknown) => {
      logger.error('[tasks] check failed', e)
      return undefined
    })
  }

  /** One scheduler tick, exported for tests and for the "run due now" moment after a system resume. */
  tick(): Promise<void> {
    return this.serial(async () => {
      const tasks = await this.raw()
      for (const task of dueTasks(tasks, Date.now())) {
        if (this.running.has(task.id)) continue
        await this.run(task)
      }
    })
  }

  private async listNow(): Promise<ScheduledTask[]> {
    const tasks = await this.raw()
    return [...tasks].sort((a, b) => (a.nextRun ?? Number.MAX_SAFE_INTEGER) - (b.nextRun ?? Number.MAX_SAFE_INTEGER))
  }

  /** Execute one task, persist its outcome, and never throw: the schedule must survive failures. */
  private async run(task: ScheduledTask): Promise<void> {
    this.running.add(task.id)
    let run: TaskRun
    try {
      await this.manager.open(task.connectionId)
      const session = this.manager.require(task.connectionId)
      const collected: unknown[][] = []
      let columns: Awaited<ReturnType<typeof session.execute>>['columns'] = []
      let offset = 0
      for (;;) {
        const page = await session.execute(task.sql, { limit: PAGE, offset, full: true })
        if (page.error) throw new Error(page.error)
        if (!columns.length) columns = page.columns
        collected.push(...page.rows)
        offset += page.rows.length
        if (!page.hasMore || !page.rows.length) break
        if (collected.length >= MAX_EXPORT_ROWS) {
          throw new Error(`The query returned more than ${MAX_EXPORT_ROWS.toLocaleString()} rows; narrow it down.`)
        }
      }
      await writeExport(task, columns, collected, session.dialect.id)
      run = {
        at: Date.now(), ok: true,
        message: `${collected.length.toLocaleString()} row(s) written to ${path.basename(task.outputPath)}`,
        rows: collected.length, file: task.outputPath,
      }
      logger.info(`[tasks] "${task.name}" exported ${collected.length} rows to ${task.outputPath}`)
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 2000)
      run = { at: Date.now(), ok: false, message }
      logger.warn(`[tasks] "${task.name}" failed: ${message}`)
    } finally {
      this.running.delete(task.id)
    }
    // A delete or edit may have happened while the query ran: only update a task that still exists.
    const tasks = await this.raw()
    const current = tasks.find((t) => t.id === task.id)
    if (!current) return
    const updated = recordRun(current, run, Date.now())
    await this.persist(tasks.map((t) => (t.id === task.id ? updated : t)))
  }
}

/** Render and replace the output file in one step: a crash never truncates the previous export. */
async function writeExport(
  task: ScheduledTask,
  columns: ColumnMeta[],
  rows: unknown[][],
  dialect: DialectId,
): Promise<void> {
  const data = task.format === 'xlsx'
    ? Buffer.from(exportXlsx(columns, rows, task.name))
    : exportText(columns, rows, task.format as ExportFormat, 'scheduled_export', dialect, { neutralizeFormulas: true })
  await mkdir(path.dirname(task.outputPath), { recursive: true })
  const tmp = `${task.outputPath}.${process.pid}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, task.outputPath)
}
