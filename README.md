<picture>
  <source media="(prefers-color-scheme: dark)" srcset="stratum-brand/logo/stratum-logo-horizontal-on-dark.svg" />
  <img src="stratum-brand/logo/stratum-logo-horizontal-on-light.svg" alt="Stratum" width="380" />
</picture>

# Stratum

A DataGrip-style database IDE built on Electron, Monaco and the VS Code theme ecosystem.
Windows · macOS · Linux (native menu; global menu bar on macOS, and on Linux desktops with a DBusMenu host).

```
npm install
npm run dev            # develop
npm run fetch:jdbc     # optional: download jdbc-adapter-server.jar (needs Java 11+ at runtime)
npm test               # unit + SQLite end-to-end tests
npm run smoke          # launches the real app headless and drives the UI
npm run dist           # installers for the current OS (run on each OS / in CI)
```

## Architecture

```
src/shared     contracts: types, IPC API, SQL splitter, DML generator, quoting   (no deps)
src/main       Electron main
  db/            Transport (how SQL travels)  ×  Dialect (what SQL says)  = DbSession
  services/      ConnectionManager, encrypted JsonStore, ThemeService, JdbcSidecar
src/preload    contextBridge: one typed `window.stratum` object
src/renderer   React workbench
  theme/         color → CSS vars + Monaco theme · file icon themes · product icon themes
  erd/           graph build → ELK placement → own orthogonal routing → pure SVG renderer
  workbench/     Explorer, Console, Table editor, Data grid, ERD view, dialogs, palette
```

Add a database = one Transport (if it needs a new wire protocol) and/or one Dialect, registered in `db/factory.ts`.
Anything with a JDBC driver already works through the generic JDBC transport. Engines without an ANSI
`information_schema` get catalog-specific introspection instead: Oracle (`ALL_*` dictionary views),
Db2 (`SYSCAT`), SAP ASE (`sysobjects`/`syscolumns`, DataGrip's bit-8 nullability mask), ClickHouse
(`system.*`), Cassandra CQL (`system_schema`) and BigQuery (region-scoped `INFORMATION_SCHEMA`).

## Themes
Any VS Code color theme, file icon theme or product icon theme works: built-ins in `themes/`, drop-ins in
`<userData>/themes`, and installed VS Code / VSCodium / Cursor extensions are discovered automatically.
Colors become `--vscode-*` CSS variables (same naming as VS Code). `scripts/improve-themes.py` regenerates the
improved Carbon themes (visible borders, `tree.tableColumnsBorder`, `charts.*`) from the originals.

## SQL completion and query tools

The completion engine (`src/shared/sqlComplete.ts`) is DataGrip-style and dialect-aware: scoped
aliases (reserved words never become implicit aliases), `schema.table.` qualifiers, INSERT column
auto-fill, JOIN generation from foreign keys, live templates (`sel`, `selw`, `selc`,
`lim`/`top`/`first`/`toprow`, `ins`, `upd`, `del`, `tab`, `view`, `col`) with DataGrip's
per-dialect availability, and per-dialect keyword and function catalogs for 23 dialects
(PostgreSQL, MySQL, MariaDB, SQLite, SQL Server, Oracle, Db2, Derby, H2, HSQLDB, SAP ASE,
Vertica, Exasol, Greenplum, Redshift, CockroachDB, Snowflake, ClickHouse, BigQuery, Hive,
Spark, Cassandra CQL, generic). Suggestions come back best-first with DataGrip-like ranking
signals (`src/shared/sqlRank.ts`): match quality (exact / prefix / middle / greedy), shorter
labels first, and word usage frequency in the console.

DataGrip registers completion providers for reference expressions (aliases, tables, columns),
column lists (INSERT auto-fill), VALUES tuples, join smart completion, function definitions,
parameter names and parser-context keywords (dummy-identifier reparse + an ML ranker). Stratum
approximates that set with bounded statement scans and the heuristic ranker above; no DataGrip
model, code or ranking weights are copied.

The catalogs are *facts* extracted from the installed DataGrip 2026.2.6 modules (keyword
constant pools, the full `token("WORD")` lexer vocabulary and `functions.xml` per dialect)
into the generated `src/shared/sqlDialectData.ts`:

```
node scripts/datagrip-keywords.mjs <classes-dir> > keywords.json   # decodes *Keywords.class
node scripts/datagrip-tokens.mjs <modules-dir> > tokens.json       # decodes *Types.class (javap)
node scripts/datagrip-catalog.mjs keywords.json tokens.json <functions-dir> src/shared/sqlDialectData.ts
```

Query tools mirror DataGrip's: SQL parameters (`:name`, `:'name'`, `:"name"`, `${name}`,
`$(name)`, `#name#`) prompted before execution and remembered between runs; per-connection
console history; grid export (CSV / TSV / pipe / semicolon, JSON, dialect-quoted SQL INSERTs)
through a native save dialog; and light Rename… / Find Usages on Explorer objects — Rename
generates the dialect-correct statement in a new console and never executes it.

## Upstream projects
* database-client/jdbc-adapter-server (MIT) — run as a sidecar over its HTTP API.
* cweijan/vscode-database-client (MIT) — an extension tightly bound to the `vscode` API (87 of 165 files import it),
  so it cannot be embedded; Stratum reuses its approach (pg / mysql2 / JDBC bridge, per-dialect SQL).
* JetBrains DataGrip — not a dependency: only factual keyword/function/template names are extracted
  from a locally installed copy (scripts above); no DataGrip code or resources are copied.
