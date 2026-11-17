import { Client } from 'pg'
import type { QueryArrayConfig } from 'pg'
import type {
  ConnectionConfig, DebugBreakpoint, DebugFrame, DebugProbe, DebugResult, DebugRoutine, DebugSnapshot,
  DebugSource, DebugStatus, DebugVariable,
} from '../../shared/types'
import { DEBUG_PORT_TIMEOUT_MS, MAX_DEBUG_ROWS, buildRoutineCall, parseDebugNotice } from '../../core/debug'
import { redactSecrets } from '../../core/connectionPreview'
import { normalizeRows } from '../db/normalize'
import { pgTypeName, postgresClientOptions } from '../db/postgresOptions'
import { logger } from '../logger'

/** The debugger uses the extended protocol so a routine expression cannot smuggle a second statement. */
type ExtendedArrayQuery = QueryArrayConfig & { queryMode: 'extended' }

const extended = (text: string): ExtendedArrayQuery => ({ text, rowMode: 'array', queryMode: 'extended' })

export const debugErrorMessage = (e: unknown): string => redactSecrets(e instanceof Error ? e.message : String(e))

/** Actionable installation hint for the usual pldbgapi/plugin_debugger failures. */
export function debuggerInstallHint(message: string): string {
  if (/permission denied|must be superuser/i.test(message)) {
    return 'Enabling the debugger needs a superuser: ask an administrator to run CREATE EXTENSION pldbgapi; in this database.'
  }
  if (/could not access file|shared library|plugin_debugger|pldbg|42883|does not exist/i.test(message)) {
    return 'Install the PostgreSQL debugger: run CREATE EXTENSION pldbgapi; in this database and add plugin_debugger to shared_preload_libraries, then restart PostgreSQL.'
  }
  return 'Check that the pldbgapi extension and the plugin_debugger library are installed on this server.'
}

async function connect(cfg: ConnectionConfig): Promise<Client> {
  const client = new Client(await postgresClientOptions(cfg))
  // An idle debug connection that dies must not crash the main process.
  client.on('error', (e: Error) => logger.warn('debug connection lost', e.message))
  await client.connect()
  return client
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ catalog queries */

const ROUTINE_FIELDS = `
  p.oid,
  n.nspname as schema,
  p.proname as name,
  case p.prokind when 'p' then 'procedure' else 'function' end as kind,
  l.lanname as language,
  pg_get_function_identity_arguments(p.oid) as signature,
  coalesce(pg_get_function_result(p.oid), '') as return_type,
  p.proretset as returns_set,
  coalesce(p.provariadic, 0) <> 0 as variadic,
  p.pronargdefaults as defaults,
  coalesce((
    select json_agg(json_build_object(
      'name', coalesce(p.proargnames[u.i::int], 'arg' || u.i),
      'type', format_type(u.oid, null),
      'mode', coalesce(p.proargmodes[u.i::int], 'i'::"char")
    ) order by u.i)
    from unnest(coalesce(
      p.proallargtypes,
      case when p.proargtypes::text = '' then '{}'::oid[] else string_to_array(p.proargtypes::text, ' ')::oid[] end
    )) with ordinality as u(oid, i)
    where p.proargmodes is null or p.proargmodes[u.i::int] in ('i', 'b', 'v')
  ), '[]'::json) as args`

const ROUTINE_FROM = `
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang`

const ROUTINE_LIST = `
  select ${ROUTINE_FIELDS}${ROUTINE_FROM}
  where p.prokind in ('f', 'p')
    and l.lanname = 'plpgsql'
    and n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname not like 'pg_toast%'
    and n.nspname not like 'pg_temp%'
  order by n.nspname, p.proname, p.oid`

const ROUTINE_ONE = `select ${ROUTINE_FIELDS}${ROUTINE_FROM} where p.oid = $1`

interface RawArgument { name: string; type: string; mode: string }

function parseArguments(value: unknown): RawArgument[] {
  let parsed: unknown = value
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { return [] }
  }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    if (typeof row.type !== 'string') return []
    return [{
      name: typeof row.name === 'string' ? row.name : '',
      type: row.type,
      mode: typeof row.mode === 'string' ? row.mode : 'i',
    }]
  })
}

function routineFromRow(row: Record<string, unknown>): DebugRoutine {
  const inputs = parseArguments(row.args).filter((a) => a.mode === 'i' || a.mode === 'b' || a.mode === 'v')
  const defaults = Math.max(0, Math.min(inputs.length, Number(row.defaults) || 0))
  const optionalFrom = inputs.length - defaults
  return {
    oid: Number(row.oid),
    schema: String(row.schema),
    name: String(row.name),
    kind: row.kind === 'procedure' ? 'procedure' : 'function',
    language: String(row.language ?? ''),
    signature: String(row.signature ?? ''),
    returnType: String(row.return_type ?? ''),
    returnsSet: row.returns_set === true,
    variadic: row.variadic === true,
    arguments: inputs.map((a, i) => ({
      name: a.name || `arg${i + 1}`,
      type: a.type,
      optional: i >= optionalFrom,
    })),
  }
}

export async function fetchDebugRoutine(client: Client, oid: number): Promise<DebugRoutine | undefined> {
  const r = await client.query(ROUTINE_ONE, [oid])
  return r.rows[0] ? routineFromRow(r.rows[0] as Record<string, unknown>) : undefined
}

/** Library + proxy version. Missing pldbgapi is an installation problem, not a connection failure. */
export async function probeDebugSupport(cfg: ConnectionConfig): Promise<DebugProbe> {
  let client: Client | undefined
  try {
    client = await connect(cfg)
    const r = await client.query('select serverversionstr, proxyapiver from pldbg_get_proxy_info()')
    const row = r.rows[0] as { serverversionstr?: string; proxyapiver?: number } | undefined
    return {
      available: true,
      serverVersion: row?.serverversionstr ? String(row.serverversionstr) : undefined,
      proxyApiVersion: Number(row?.proxyapiver) || undefined,
    }
  } catch (e) {
    const error = debugErrorMessage(e)
    return { available: false, error, hint: debuggerInstallHint(error) }
  } finally {
    await client?.end().catch(() => undefined)
  }
}

export async function listDebugRoutines(cfg: ConnectionConfig): Promise<DebugRoutine[]> {
  const client = await connect(cfg)
  try {
    const r = await client.query(ROUTINE_LIST)
    return r.rows.map((row) => routineFromRow(row as Record<string, unknown>))
  } finally {
    await client.end().catch(() => undefined)
  }
}

/* ------------------------------------------------------------------ row mapping */

const number = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

const breakpointFromRow = (row: Record<string, unknown>): DebugBreakpoint => ({
  oid: number(row.func),
  line: number(row.linenumber),
  target: row.targetname === null || row.targetname === undefined || row.targetname === '' ? undefined : String(row.targetname),
})

const frameFromRow = (row: Record<string, unknown>): DebugFrame => ({
  level: number(row.level),
  name: String(row.targetname ?? ''),
  oid: number(row.func),
  line: number(row.linenumber),
  args: String(row.args ?? ''),
})

const variableFromRow = (row: Record<string, unknown>, types: Map<number, string>): DebugVariable => {
  const oid = number(row.dtype)
  return {
    name: String(row.name ?? ''),
    line: number(row.linenumber),
    unique: row.isunique === true,
    constant: row.isconst === true,
    notNull: row.isnotnull === true,
    typeOid: oid,
    type: types.get(oid) ?? pgTypeName(oid),
    value: row.value === null || row.value === undefined ? null : String(row.value),
  }
}

interface TargetOutcome {
  ok: boolean
  error?: string
  result?: DebugResult
}

/* ------------------------------------------------------------------ session */

/**
 * One local debug session. Two connections: the controller runs the `pldbg_*` proxy functions,
 * the target executes the routine and blocks in the debugger. A single routine call per session
 * keeps the mapping between a stop and the code shown on screen unambiguous.
 */
export class PostgresDebugSession {
  private status: DebugStatus = 'paused'
  private sessionId?: number
  private controllerPid?: number
  private targetPid?: number
  private current?: DebugBreakpoint
  private frames: DebugFrame[] = []
  private variables: DebugVariable[] = []
  private breakpoints: DebugBreakpoint[] = []
  private selectedFrame = 0
  private source?: DebugSource
  private result?: DebugResult
  private error?: string
  private targetOutcome?: TargetOutcome
  private targetSettled = false
  private targetDone?: Promise<void>
  private inFlight?: Promise<unknown>
  private stopping = false
  private clientsClosed = false
  private readonly sourceCache = new Map<number, DebugSource>()

  private portResolve?: (port: number) => void
  private portTimer?: ReturnType<typeof setTimeout>

  constructor(
    readonly id: string,
    private readonly cfg: ConnectionConfig,
    readonly routine: DebugRoutine,
    private readonly callSql: string,
    private readonly controller: Client,
    private readonly target: Client,
    private readonly release: () => void,
  ) {}

  /* ---------------------------------------------------------------- attach / finish */

  async attach(): Promise<void> {
    this.controllerPid = (this.controller as unknown as { processID?: number | null }).processID ?? undefined
    this.targetPid = (this.target as unknown as { processID?: number | null }).processID ?? undefined
    this.target.on('notice', (msg: { message?: string }) => {
      const port = parseDebugNotice(msg.message)
      if (port === undefined || !this.portResolve) return
      const resolve = this.portResolve
      this.portResolve = undefined
      if (this.portTimer) clearTimeout(this.portTimer)
      resolve(port)
    })
    // A user or role may have silenced notices; the target announces its port that way.
    await this.target.query("set client_min_messages = notice")
    await this.target.query('begin')
    const prepared = await this.target.query('select pldbg_oid_debug($1) as installed', [this.routine.oid])
    if (number(prepared.rows[0]?.installed) !== 0) {
      throw new Error('The server did not install the entry breakpoint for this routine.')
    }
    const portPromise = this.armPortWaiter()
    this.startTarget()
    const port = await Promise.race([
      portPromise,
      this.targetDone!.then(() => {
        throw new Error(this.targetOutcome?.error ?? 'The routine finished before the debugger could attach.')
      }),
    ])
    const attached = await this.controller.query('select pldbg_attach_to_port($1) as sessionid', [port])
    const sessionId = number(attached.rows[0]?.sessionid)
    if (!Number.isInteger(sessionId) || sessionId <= 0) throw new Error('The server did not return a debug session id.')
    this.sessionId = sessionId
    const stop = await this.controller.query('select * from pldbg_wait_for_breakpoint($1)', [sessionId])
    if (stop.rows[0]) this.current = breakpointFromRow(stop.rows[0] as Record<string, unknown>)
    await this.refresh()
  }

  private armPortWaiter(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      this.portResolve = resolve
      this.portTimer = setTimeout(() => {
        this.portResolve = undefined
        reject(new Error(`The routine did not announce its debug port within ${Math.round(DEBUG_PORT_TIMEOUT_MS / 1000)} seconds. Check that plugin_debugger is loaded and client_min_messages is not above NOTICE.`))
      }, DEBUG_PORT_TIMEOUT_MS)
    })
  }

  private startTarget(): void {
    const started = performance.now()
    this.targetDone = this.target.query(extended(this.callSql))
      .then((r) => {
        this.targetSettled = true
        this.targetOutcome = { ok: true, result: this.resultFromQuery(r, Math.round(performance.now() - started)) }
      })
      .catch((e: unknown) => {
        this.targetSettled = true
        this.targetOutcome = { ok: false, error: debugErrorMessage(e) }
      })
  }

  private resultFromQuery(r: { fields?: { name: string; dataTypeID: number }[]; rows: unknown[][] }, durationMs: number): DebugResult {
    const rows = r.rows ?? []
    const normalized = normalizeRows(rows.slice(0, MAX_DEBUG_ROWS), false)
    return {
      sql: this.callSql,
      durationMs,
      columns: (r.fields ?? []).map((f) => ({ name: f.name, type: pgTypeName(f.dataTypeID) })),
      rows: normalized.rows,
      truncated: rows.length > MAX_DEBUG_ROWS,
    }
  }

  /* ---------------------------------------------------------------- reads */

  private async refresh(): Promise<void> {
    const sessionId = this.sessionId
    if (!sessionId) return
    const stack = await this.controller.query('select * from pldbg_get_stack($1)', [sessionId])
    this.frames = stack.rows.map((row) => frameFromRow(row as Record<string, unknown>))
    if (!this.frames.length) return
    // A stop focuses the innermost frame; an explicit frame selection survives until the next stop.
    if (!this.frames.some((f) => f.level === this.selectedFrame)) this.selectedFrame = this.frames[0].level
    await this.controller.query('select * from pldbg_select_frame($1,$2)', [sessionId, this.selectedFrame])
    const frame = this.frames.find((f) => f.level === this.selectedFrame) ?? this.frames[0]
    this.current = { oid: frame.oid, line: frame.line }
    this.source = await this.loadSource(sessionId, frame.oid).catch((e: unknown) => {
      logger.warn('debug source unavailable', debugErrorMessage(e))
      return undefined
    })
    const vars = await this.controller.query('select * from pldbg_get_variables($1)', [sessionId])
    const types = await this.typeNames(vars.rows.map((row) => number((row as Record<string, unknown>).dtype)))
    this.variables = vars.rows.map((row) => variableFromRow(row as Record<string, unknown>, types))
    await this.refreshBreakpoints(sessionId)
  }

  private async loadSource(sessionId: number, oid: number): Promise<DebugSource | undefined> {
    const cached = this.sourceCache.get(oid)
    if (cached) return cached
    const r = await this.controller.query(
      `select pldbg_get_source($1,$2) as source, n.nspname as schema, p.proname as name
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.oid = $2`,
      [sessionId, oid],
    )
    const row = r.rows[0] as { source?: string | null; schema?: string; name?: string } | undefined
    if (!row || row.source === null || row.source === undefined) return undefined
    const source: DebugSource = {
      oid,
      schema: String(row.schema ?? this.routine.schema),
      name: String(row.name ?? this.routine.name),
      text: String(row.source),
    }
    this.sourceCache.set(oid, source)
    return source
  }

  private async typeNames(oids: number[]): Promise<Map<number, string>> {
    const unique = [...new Set(oids.filter((n) => Number.isInteger(n) && n > 0))]
    const map = new Map<number, string>()
    if (!unique.length) return map
    try {
      const r = await this.controller.query('select oid, format_type(oid, null) as name from pg_type where oid = any($1::oid[])', [unique])
      for (const row of r.rows as { oid: number; name: string }[]) map.set(number(row.oid), String(row.name))
    } catch { /* the OID fallback is enough to keep the panel useful */ }
    return map
  }

  private async refreshBreakpoints(sessionId = this.sessionId): Promise<void> {
    if (!sessionId) return
    const r = await this.controller.query('select * from pldbg_get_breakpoints($1)', [sessionId])
    this.breakpoints = r.rows
      .map((row) => breakpointFromRow(row as Record<string, unknown>))
      .filter((bp) => bp.line !== 0)
  }

  /* ---------------------------------------------------------------- commands */

  async liveSnapshot(): Promise<DebugSnapshot> {
    if (this.status === 'paused' && this.sessionId && !this.inFlight) {
      try { await this.refresh() } catch (e) { this.error = debugErrorMessage(e) }
    }
    return this.snapshot()
  }

  async step(action: 'continue' | 'step_over' | 'step_into'): Promise<DebugSnapshot> {
    const sessionId = this.sessionId
    if (!sessionId) return this.failed('The debug session is not attached.')
    if (this.status !== 'paused') return this.snapshot()
    this.status = 'running'
    this.error = undefined
    const query = this.controller.query(`select * from pldbg_${action}($1)`, [sessionId])
    this.inFlight = query
    try {
      const r = await query
      if (this.stopping) { this.status = 'stopped'; return this.snapshot() }
      if (r.rows[0]) this.current = breakpointFromRow(r.rows[0] as Record<string, unknown>)
      this.status = 'paused'
      await this.refresh()
    } catch (e) {
      if (this.stopping) { this.status = 'stopped'; return this.snapshot() }
      // `pldbg_continue/step` reports the end of the target as an error; let the outcome decide.
      if (!this.targetSettled) await Promise.race([this.targetDone ?? Promise.resolve(), delay(750)])
      if (this.targetSettled) this.applyOutcome()
      else {
        this.status = 'paused'
        this.error = debugErrorMessage(e)
      }
    } finally {
      if (this.inFlight === query) this.inFlight = undefined
    }
    return this.snapshot()
  }

  async selectFrame(level: number): Promise<DebugSnapshot> {
    if (this.status !== 'paused') return this.snapshot()
    if (!this.frames.some((f) => f.level === level)) return this.failed(`Frame ${level} is not in the current stack.`)
    this.selectedFrame = level
    try { await this.refresh() } catch (e) { this.error = debugErrorMessage(e) }
    return this.snapshot()
  }

  async toggleBreakpoint(oid: number, line: number, enabled: boolean): Promise<DebugSnapshot> {
    const sessionId = this.sessionId
    if (!sessionId) return this.failed('The debug session is not attached.')
    if (!Number.isInteger(oid) || oid <= 0) return this.failed('Invalid routine id for a breakpoint.')
    if (!Number.isInteger(line) || line < 1) return this.failed('Breakpoints must be placed on a body line.')
    try {
      const fn = enabled ? 'pldbg_set_breakpoint' : 'pldbg_drop_breakpoint'
      const r = await this.controller.query(`select ${fn}($1,$2,$3) as ok`, [sessionId, oid, line])
      if (r.rows[0]?.ok === false) throw new Error(`The server rejected the breakpoint on line ${line}.`)
      await this.refreshBreakpoints(sessionId)
      this.error = undefined
    } catch (e) {
      this.error = debugErrorMessage(e)
    }
    return this.snapshot()
  }

  async setVariable(name: string, line: number, value: string): Promise<DebugSnapshot> {
    const sessionId = this.sessionId
    if (!sessionId) return this.failed('The debug session is not attached.')
    if (!name || !Number.isInteger(line) || line < 0) return this.failed('Invalid variable.')
    if (!value.trim()) return this.failed('Enter a SQL expression for the new value (for example 42 or \'text\').')
    try {
      const r = await this.controller.query('select pldbg_deposit_value($1,$2,$3,$4) as ok', [sessionId, name, line, value])
      if (r.rows[0]?.ok === false) throw new Error(`The server could not assign the value to ${name}.`)
      await this.refresh()
      this.error = undefined
    } catch (e) {
      this.error = debugErrorMessage(e)
    }
    return this.snapshot()
  }

  /* ---------------------------------------------------------------- stop / close */

  async stop(): Promise<DebugSnapshot> {
    if (this.status === 'stopped') return this.snapshot()
    this.stopping = true
    try {
      // A proxy command blocks while the target runs; cancel it before asking the target to abort.
      if (this.inFlight) {
        await this.cancelBackend(this.controllerPid)
        await Promise.race([this.inFlight.catch(() => undefined), delay(3_000)])
      }
      if (this.sessionId && !this.targetSettled) {
        try { await this.controller.query('select * from pldbg_abort_target($1)', [this.sessionId]) }
        catch (e) { logger.warn('debug abort failed; closing the target connection instead', debugErrorMessage(e)) }
      }
      const settled = this.targetDone
        ? await Promise.race([this.targetDone.then(() => true).catch(() => true), delay(3_000).then(() => false)])
        : true
      if (settled) await this.target.query('rollback').catch(() => undefined)
    } finally {
      this.status = 'stopped'
      this.current = undefined
      this.frames = []
      this.variables = []
      this.error = undefined
      this.sessionId = undefined
      await this.closeClients()
    }
    return this.snapshot()
  }

  /** Cancel the controller backend from a side connection, so a blocked proxy call can be released. */
  private async cancelBackend(pid: number | undefined): Promise<void> {
    if (!pid) return
    let side: Client | undefined
    try {
      side = await connect(this.cfg)
      const r = await side.query('select pg_cancel_backend($1) as cancelled', [pid])
      if (r.rows[0]?.cancelled === false) await side.query('select pg_terminate_backend($1)', [pid])
    } catch (e) {
      logger.warn('debug cancel failed', debugErrorMessage(e))
    } finally {
      await side?.end().catch(() => undefined)
    }
  }

  private async closeClients(): Promise<void> {
    if (this.clientsClosed) return
    this.clientsClosed = true
    await Promise.all([this.controller.end().catch(() => undefined), this.target.end().catch(() => undefined)])
    this.release()
  }

  /* ---------------------------------------------------------------- snapshot */

  private applyOutcome(): void {
    this.status = this.targetOutcome?.ok ? 'finished' : 'failed'
    this.error = this.targetOutcome?.ok ? undefined : this.targetOutcome?.error
    this.result = this.targetOutcome?.result
    this.current = undefined
    this.frames = []
    this.variables = []
    this.selectedFrame = 0
  }

  private failed(message: string): DebugSnapshot {
    this.error = message
    return this.snapshot()
  }

  snapshot(): DebugSnapshot {
    return {
      id: this.id,
      status: this.status,
      routine: this.routine,
      breakpoint: this.current,
      frames: [...this.frames],
      selectedFrame: this.selectedFrame,
      source: this.source,
      variables: [...this.variables],
      breakpoints: [...this.breakpoints],
      result: this.result,
      error: this.error,
    }
  }
}
export async function createPostgresDebugSession(
  id: string,
  cfg: ConnectionConfig,
  oid: number,
  values: readonly string[],
  release: () => void,
): Promise<PostgresDebugSession> {
  let controller: Client | undefined
  let target: Client | undefined
  try {
    controller = await connect(cfg)
    const routine = await fetchDebugRoutine(controller, oid)
    if (!routine) throw new Error(`Routine ${oid} was not found in this database.`)
    const callSql = buildRoutineCall(routine, values)
    target = await connect(cfg)
    const session = new PostgresDebugSession(id, cfg, routine, callSql, controller, target, release)
    await session.attach()
    return session
  } catch (e) {
    await target?.end().catch(() => undefined)
    await controller?.end().catch(() => undefined)
    release()
    const message = debugErrorMessage(e)
    throw new Error(/pldbg|plugin_debugger|shared library|42883|does not exist/i.test(message)
      ? `${message}\n${debuggerInstallHint(message)}`
      : message)
  }
}

/** Connects both clients, reads the routine from the catalog and stops it at its entry breakpoint. */