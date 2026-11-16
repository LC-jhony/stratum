# Phase 2 — Savepoints and SQL script control commands

Two DBeaver workhorses land here: a transaction bar that can mark intermediate states, and the
`@set` / `@include` / `@export` commands that turn a console into a small, repeatable script.

## Savepoints

- **Model.** `DbSession` owns the list of savepoints created from the UI and mirrors it into
  `TransactionState.savepoints` (creation order). `TransactionState` keeps the field optional and
  omits it when the list is empty, so the type stays compatible with drivers that know nothing
  about savepoints. `src/shared/types.ts` documents the field as advisory: the server is the
  authority.
- **Names.** `DbSession.savepointName` accepts only SQL identifiers (letter or `_` first, then up
  to 62 letters, digits, `_` or `$`). Every engine branch interpolates that validated name and
  nothing else, so a name typed in the toolbar cannot inject SQL.
- **Grammar per engine.** `savepointSql` is the single place that knows the differences:

  | Engine | Create | Roll back | Release |
  | --- | --- | --- | --- |
  | PostgreSQL family, MySQL family | `SAVEPOINT n` | `ROLLBACK TO SAVEPOINT n` | `RELEASE SAVEPOINT n` |
  | SQLite | `SAVEPOINT n` | `ROLLBACK TO n` | `RELEASE n` |
  | Db2 | `SAVEPOINT n ON ROLLBACK RETAIN CURSORS` | `ROLLBACK TO SAVEPOINT n` | `RELEASE TO SAVEPOINT n` |
  | SQL Server / Sybase | `SAVE TRANSACTION n` | `ROLLBACK TRANSACTION n` | rejected: the engine has no statement |
  | Oracle | `SAVEPOINT n` | `ROLLBACK TO SAVEPOINT n` | rejected: savepoints only disappear on commit/rollback |

- **Creating one inside auto-commit** opens a transaction first. Rolling back to or releasing a
  savepoint without an open transaction is rejected with a clear message.
- **Release semantics.** PostgreSQL, SQLite and Db2 drop the named savepoint and every later one;
  MySQL drops only the named one. The tracked list mirrors exactly that, so the bar cannot show a
  savepoint the server no longer has.
- **Rollback keeps the savepoint.** `ROLLBACK TO` rewinds the data but leaves the mark usable, so
  the list is truncated to `index + 1`.
- **UI.** The transaction bar shows one chip per savepoint, an inline name field (`sp1`, `sp2`…
  prefilled) and per-chip rollback/release actions. Rollback asks for confirmation because it
  discards changes. Styles: `.tx-bar .tx-sp`, `.tx-sp-edit` in `styles.css`.

### The bug this phase fixed

`ROLLBACK TO savepoint` was being read as a full `ROLLBACK` by the transaction-boundary detector.
Consequences: the SQLite transport persisted a database that still had an open transaction, and the
session marked the transaction closed while the engine kept it open. `src/main/db/transports/tx.ts`
now excludes:

- `ROLLBACK TO [SAVEPOINT] name` (ISO / PostgreSQL / SQLite),
- `ROLLBACK WORK|TRANSACTION TO …`,
- SQL Server's `ROLLBACK TRANSACTION savepoint_name`,

while a bare `ROLLBACK` / `ROLLBACK WORK` / `ROLLBACK TRANSACTION` still ends the transaction.
`sqlite.ts` applies the same exception before deciding whether to persist.

## Script control commands

`src/core/script.ts` parses a script into SQL statements and commands **in source order**.

| Command | Meaning |
| --- | --- |
| `@set name = value` | Sets a script variable for the rest of the run. Quotes around the value are stripped; `=` and `;` inside quotes survive. |
| `@include path` | Runs another script inline, at that point. |
| `@export path [format]` | Writes the previous result (or the last grid result) through a native save dialog. |

Parsing rules:

- A command is recognized only when it is the first non-space text on a line **and** the line starts
  outside a string, quoted identifier, block comment or `$tag$` body. A `@set` stored as data is
  never executed.
- Commands act as statement boundaries, so `select 1` followed by `@set x = 2` needs no semicolon.
- Unknown `@` lines stay SQL, which keeps MySQL user variables (`@foo := 1`) working.
- A trailing `;` after a command is accepted; quoted paths may contain spaces.
- Errors name the offending line: `Line 3: @set needs "name = value".`

Execution (`src/renderer/src/store/slices/console.ts`):

- Script variables layer **on top of** global and connection values for the current run only. They
  are expanded with the same `${name}` / `$(name)` rules and are not persisted.
- `@include` resolves a relative path next to the including file; a top-level console has no path
  yet, so it resolves against the user's Documents folder. `~` expands to the home directory.
  Absolute paths are accepted.
- Includes inherit the current variables and propagate their own `@set` back to the caller.
- Limits: depth 10, 50 files per run, 16 MB per file, cycle detection on resolved paths. Every
  failure becomes a result entry with the file path, and execution stops.
- `@export` infers the format from the extension (`.csv`, `.tsv`/`.txt`→TSV, `.json`, `.sql`→INSERT,
  `.xlsx`), or takes an explicit one (`csv`, `tsv`, `pipe`, `semicolon`, `json`, `insert`, `xlsx`).
  It collects every page through `collectRows`, so a paged grid exports completely, and prompts for
  a path with the native save dialog. The result of the export appears as a two-column result:
  saved file and row count.
- History stores what the user wrote, not the expanded SQL.

Supporting changes:

- `DesktopService.readText` performs the include read in the main process and validates the path,
  file type and size; the renderer never receives a directory listing.
- New IPC channel `script.read(path, from?)`, declared in `src/shared/ipc.ts`, validated by
  `scriptPathSchema` and exposed through the preload bridge.
- Fixed a real bug found by the smoke run: `ResultsPane` passed the **tab** id to `ExportMenu` as
  the connection id, so "Export data" from the grid could not page the result set.

### IPC argument count

The router used to require `args.length === schemas.length`, which rejected legitimate calls that
omit trailing optional arguments (`db.execute(id, sql)`). It now rejects only **extra** arguments;
a missing required argument still fails when its schema parses `undefined`. This was found by the
Wayland smoke run, not by the type checker, because both sides were individually valid.

## Verification

- `npm run verify`: typecheck, dependency-cruiser (157 modules, 477 dependencies), 496 tests passed
  / 42 skipped, production build.
- New coverage: `tests/tx.test.ts` (transaction boundaries including savepoint rollback),
  `tests/script.test.ts` (12 parser tests), `tests/scriptRun.test.ts` (10 execution tests: variables,
  includes, nesting, cycles, missing files, exports, malformed commands, SQL errors),
  `tests/desktopReadText.test.ts` (6 path/limit tests), plus the extended savepoint test in
  `tests/db.test.ts`.
- Wayland smoke on SQLite: `@set who = script` produced `script`, `@include` produced `included`,
  a table was created and filled. Savepoint `sp1` appeared in the bar; an `UPDATE` was reverted by
  `ROLLBACK TO sp1` (`changed` → `base`) with the transaction still open; `RELEASE sp1` removed the
  chip and left the transaction open.
- `@export` cannot run in the smoke because it needs a human in a native dialog; it is covered by
  `tests/scriptRun.test.ts`.

## Deliberate limits

- A console does not have a file path yet, so top-level relative includes fall back to Documents.
  Opening/saving `.sql` files with a real path is the next gap.
- Commands run in the console only. Import scripts, generated DDL and the ERD export do not parse
  them.
- `@export` always shows the save dialog; there is no silent overwrite mode.
- No `@if`, `@log`, `@connect` or other DBeaver control commands yet.
- Script variables do not survive the run and are not shared between consoles.
