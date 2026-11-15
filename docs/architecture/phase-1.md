# Phase 1 — Connection portability, SQL variables and the driver manager

This phase makes data sources portable and configurable without exposing credentials: connection
settings can move between machines, SQL text can carry named variables, and JDBC libraries are
managed inside Stratum instead of being referenced from arbitrary download folders.

## SQL variables

- Global values live in `variables.global` (`<userData>/settings.json`, edited in
  **Settings → SQL variables**).
- A data source can override any name through `ConnectionConfig.variables`
  (**Data source → Session → Variables**).
- `applyVariables` in `src/core/sqlParams.ts` expands `${name}` and `$(name)` before parameter
  detection. The resolved map is `{ ...global, ...connection }`, so a connection value wins.
- An undefined name is left untouched; `findParams` then treats it like any other parameter and
  the normal parameter dialog asks for it. An explicitly empty value expands to an empty string.
- Expansion runs in both **Execute** and **Explain**, so the plan describes the SQL that actually
  runs. `:name`, `:'name'` and `#name#` parameters keep their existing behaviour; variable syntax
  is deliberately separate.

## Connection import/export

Format (`src/core/connectionTransfer.ts`):

```json
{
  "format": "stratum.connections",
  "version": 1,
  "exportedAt": "2026-11-14T00:00:00.000Z",
  "connections": [{ "id": "…", "name": "…", "kind": "postgres", "host": "…" }]
}
```

- **No secrets.** `password`, `sslKeyPassphrase`, SSH `password`/`passphrase` and jump-host
  credentials are removed. Renderer-only flags such as `hasPassword` are not copied either: the
  sanitizer rebuilds every connection from an allow-list of fields instead of deleting keys.
- Fields kept: host, port, user, database, URI/auth source, socket/file paths, SSL settings and
  certificate paths (not passphrases), safety profile, color, write confirmation, session policy,
  SQL variables, SSH topology (hosts, users, key paths, jump hosts), JDBC URL/class/dialect and the
  folder label.
- **Import never overwrites.** Every entry gets a fresh id; duplicate names become `name (2)`,
  `name (3)`… Existing data sources are untouched.
- Import validates kinds, ports, enums and sizes, skips invalid entries and reports warnings. The
  whole batch is persisted with one `ConnectionStore.saveMany` write, so a failed import does not
  leave half a list behind.
- A bare JSON array is accepted for hand-written files. Unknown formats, future versions, empty
  files and files with no valid entry are rejected with an actionable message.
- Entry points: **File → Import/Export Data Sources…**, the command palette, and the connection
  service over IPC. File pickers are native dialogs; nothing is written to a path the user did not
  choose.

## JDBC driver manager

- `src/shared/drivers.ts` defines `DriverJar` (managed path, name, size, modification time).
- `DriverService` owns `<userData>/drivers`:
  - `add` opens a native multi-file dialog and **copies** the chosen `.jar` files, so later cleanup
    of a download folder cannot break a connection. A name clash becomes `driver-2.jar`.
  - `list` returns only files directly inside the managed folder, sorted by name.
  - `remove` and `reveal` resolve the requested path and reject anything outside the folder, so the
    renderer cannot delete arbitrary files.
  - JARs above 512 MB are refused; a non-JAR selection is reported instead of copied.
- The **Driver Manager** dialog (Database menu, command palette) lists, reveals, removes and adds
  drivers and opens the managed folder. `formatBytes` and the file date keep the list readable.
- The JDBC **Driver file** field in the data-source dialog offers the managed JARs through a
  `datalist`, while still accepting a typed path for drivers kept elsewhere.

## Verification

- `npm run verify`: typecheck, dependency-cruiser, 463 tests passed / 42 skipped, production build.
- Unit coverage: `tests/sqlParams.test.ts` (expansion and parameters),
  `tests/connectionTransfer.test.ts` (secret stripping, round-trip, invalid input, naming),
  `tests/driverService.test.ts` (copy, dedupe, path escapes, reveal).
- Wayland smoke: a console statement `select '${who}' as who` executed with a connection value
  `who=connection` while the global value was `who=global`, and returned `connection`; the Driver
  Manager opened with an empty managed list; the Settings variable editor added a row and closed
  cleanly.

## Deliberate limits

- The export format is Stratum's own; importing DBeaver/DataGrip project files is not implemented.
- Drivers are added manually. An online catalog with automatic download, checksums and version
  selection is still pending; the existing test/build path accepts any JDBC JAR the user supplies.
- ODBC is not supported by the bundled adapter.
- Variables are expanded in console execution and plans; grid-generated SQL and import scripts do
  not read them yet.
