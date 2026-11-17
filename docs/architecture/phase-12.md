# Phase 12 — PL/pgSQL routine debugger

The closing feature of the approved plan: debug PL/pgSQL functions and procedures from Stratum
using the `pldbgapi` / `plugin_debugger` proxy API. The protocol implementation follows DBeaver's
local attach flow, but the code is new; no Eclipse or SWT code is reused.

## Two connections, one routine

Each debug session opens **two independent PostgreSQL connections** sourced from the same
data-source profile:

- **Controller** — runs the `pldbg_*` proxy functions (`attach_to_port`, `wait_for_breakpoint`,
  `get_stack`, `get_variables`, `step_over`, `deposit_value`, …).
- **Target** — calls the routine and blocks inside the debugger when it hits a breakpoint.

`start` proceeds as follows (`src/main/debug/postgresDebugSession.ts`):

1. Open the controller and read the routine from `pg_proc`.
2. Open the target, raise `client_min_messages` to `notice`, `BEGIN`, then
   `SELECT pldbg_oid_debug($oid)`. This installs the implicit entry breakpoint.
3. Run the target call asynchronously. The server emits `NOTICE PLDBGBREAK:<port>`; the session
   parses it with `parseDebugNotice` (whole-message match, port 1–65535).
4. On the controller: `SELECT pldbg_attach_to_port($port)`, then
   `SELECT * FROM pldbg_wait_for_breakpoint($session)`.
5. Read stack, source, variables and breakpoints, and return the first `DebugSnapshot`.

`pldbg_attach_to_port` buffers the initial stop until `pldbg_wait_for_breakpoint` consumes it. The
entry breakpoint stops on the routine's **first executable statement**, not on `DECLARE` and not on
line `-1`; the line shown is the one the server reports in the stop tuple. Source text from
`pldbg_get_source` begins with a leading blank line, and breakpoint lines are absolute in that text,
so the gutter and the server agree without translating.

Both clients share **one** SSH tunnel or proxy helper (`acquireTunnel` / `acquireProxy`), refcounted
once and released when the session closes. The helper's rewritten config is passed to both, so a
debug session behind a jump host behaves like a normal connection.

## Target call safety

The pure helpers live in `src/core/debug.ts`:

- Identifiers are quoted (`"public"."charge"`), never interpolated.
- Each argument is a **SQL expression** wrapped in parentheses and cast to the declared parameter
  type: `("42")::integer`, `('ana')::text`, `(now())::timestamptz`.
- Trailing parameters with `DEFAULT` may be omitted. A blank in the middle is rejected; so is a
  missing required value.
- Functions are bounded with `LIMIT 501` (`MAX_DEBUG_ROWS = 500` plus one probe row); procedures
  run as a plain `CALL`.

The target query is sent with `queryMode: 'extended'`. Passing `values: []` would make `pg` choose
the simple protocol, which would allow a value to smuggle a second statement. Extended protocol
guarantees one statement, so the only injection surface is the expression the user explicitly typed
for a parameter — the same trust the console already gives them.

`validateRoutineForDebug` rejects, with an actionable message: non-PL/pgSQL languages, trigger
functions, `SETOF record` without a column definition list, polymorphic and pseudo-types, and
`VARIADIC` parameters. The picker marks those routines as unsupported and disables Start.

## Transactions and stopping

The target call always runs inside an explicit transaction. The debugger **never commits**: a
finished routine can be inspected, but closing the tab or quitting rolls the work back. This makes
the debugger safe against a routine that writes.

- `pldbg_continue/step_over/step_into` block until the next breakpoint or until the target ends.
- When the target ends, the pending proxy call fails; the session waits briefly for the target
  promise and maps the outcome to `finished` (with result rows) or `failed`.
- **Stop** remains available while a step is blocked. It cancels the controller backend from a side
  connection (`pg_cancel_backend`, then `pg_terminate_backend`), runs `pldbg_abort_target`, lets the
  target settle for up to 3 s, rolls back, closes both clients and releases the helper. Closing a
  live tab confirms first; `before-quit` calls `DebugService.closeAll()`.

Variable editing uses `pldbg_deposit_value(session, name, line, value)`. The fourth argument is a
**SQL expression**, not a literal: `pldbgapi.c` documents it as an expression that must produce a
value compatible with the variable, and the proxy forwards it to the language plugin's
`do_deposit`. The UI therefore labels the field "SQL expression" and accepts `42`, `'text'` or
`now()`. Constants are read-only; the server would reject the assignment.

Rollback covers the target transaction. Effects that PostgreSQL does not undo on `ROLLBACK` —
sequence increments, external calls made by the routine, `COPY ... PROGRAM` — are not reverted; the
debugger is not a sandbox.

Every command returns a full `DebugSnapshot`; the renderer never reconstructs stack or variables
locally. Late responses after Stop are ignored, and a step that resolves after the user pressed Stop
cannot resurrect the paused view.

## UI

- **Entry points**: bug button in a PostgreSQL console toolbar, *Debug Stored Routine…* in the
  Explorer connection context menu, and the command palette (`debug.open`).
- **Routine picker** (`DebugRoutineDialog`): probe and catalog load in parallel, so a missing
  extension shows its install hint immediately. Search by schema/name/signature, schema grouping,
  argument form with optional markers, live target-call preview, and an explicit entry-breakpoint
  wait state.
- **Debug tab** (`DebugView`): read-only Monaco source with gutter breakpoints (`debug-bp`) and a
  current-line arrow/decoration, call stack, variables with inline assignment, result table, and
  Continue / Step over / Step into / Stop. Toolbar glyphs are custom (`debug-alt`,
  `debug-continue`, `debug-step-over`, `debug-step-into`); the tab is not persisted in workspace
  snapshots because only consoles are serialized.

## Verification

Pure tests — `npx vitest run tests/debug.test.ts` — cover notices, validation, call generation
(quoting, casts, defaults, hostile identifiers) and source helpers.

Live backend test (opt-in) against a disposable PostgreSQL with `pldbgapi` installed:

```bash
STRATUM_PG_DEBUG=1 npx vitest run tests/debugLive.test.ts
```

It attaches, checks the entry stop, sets a line breakpoint, reads and edits `v_total`, runs to the
result (`"105"` as numeric text), verifies rollback and that a procedure's default argument can be
omitted. The defaults point at the disposable local server (`/tmp/opencode/pgsock`, port 55432,
user `postgres`); override them with `STRATUM_PG_HOST`, `STRATUM_PG_PORT`, `STRATUM_PG_USER`,
`STRATUM_PG_PASSWORD` and `STRATUM_PG_DATABASE`.

End-to-end UI smoke (opt-in, requires the same server and the `debug_add`/`debug_touch` demo
routines described by the test):

```bash
npx electron-vite build
STRATUM_PG_DEBUG=1 STRATUM_SMOKE=$PWD/scripts/smoke-debug.js \
  npx electron . --no-sandbox --ozone-platform=wayland
```

The standard gate is `npm run verify` (typecheck + dependency-cruiser + 640 tests + build); the
live debugger test is skipped unless `STRATUM_PG_DEBUG=1` is set.

## Limits

- PostgreSQL only. MySQL/MariaDB debugging is not part of this phase.
- PostgreSQL 11 or newer: the routine catalog uses `pg_proc.prokind`.
- `pldbgapi` must be installed in the database and `plugin_debugger` must be in
  `shared_preload_libraries`; the picker reports the concrete install hint when either is missing.
- One routine invocation per session; global breakpoints (`pldbg_create_listener` /
  `pldbg_set_global_breakpoint`) are not wired to the UI.
- Linux/macOS/Windows installers remain unsigned until signing secrets are configured; the debugger
  does not change that.
