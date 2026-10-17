<picture>
  <source media="(prefers-color-scheme: dark)" srcset="stratum-brand/logo/stratum-logo-horizontal-on-dark.svg" />
  <img src="stratum-brand/logo/stratum-logo-horizontal-on-light.svg" alt="Stratum" width="380" />
</picture>

# Stratum

A DataGrip-style database IDE built on Electron, Monaco and the VS Code theme ecosystem.
Windows · macOS · Linux (native menu; global menu bar on macOS, and on Linux desktops with a DBusMenu host).

![Stratum workbench: database explorer, SQL console, results grid and ER diagram](stratum-brand/preview.png)

## Contents

- [What you get](#what-you-get)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Supported databases](#supported-databases)
- [The workbench](#the-workbench)
- [SQL completion](#sql-completion)
- [Query console](#query-console)
- [Results grid](#results-grid)
- [Table data editor](#table-data-editor)
- [Exporting data](#exporting-data)
- [Entity-relationship diagrams](#entity-relationship-diagrams)
- [Themes and appearance](#themes-and-appearance)
- [Settings](#settings)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Where your data lives](#where-your-data-lives)
- [Architecture](#architecture)
- [Development](#development)
- [Testing](#testing)
- [Packaging installers](#packaging-installers)
- [Project layout](#project-layout)
- [Maintenance scripts](#maintenance-scripts)
- [Upstream projects](#upstream-projects)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## What you get

- **Data sources.** PostgreSQL, MySQL / MariaDB and SQLite work out of the box; anything with a JDBC
  driver (Oracle, Db2, SQL Server, Snowflake, ClickHouse…) works through the bundled
  [jdbc-adapter-server](https://github.com/database-client/jdbc-adapter-server) sidecar. Connections
  support SSL, a read-only mode, Test Connection, and passwords are sealed with the OS keychain.
- **Database Explorer.** Schemas, tables, views, columns (with PK / FK badges and nullability), and
  indexes; a filter box; context menus for opening consoles, data editors and diagrams; plus
  light Rename… / Find Usages helpers that generate SQL instead of silently executing it.
- **SQL consoles.** Monaco with statement-under-caret execution, whole-script execution, cancel,
  per-connection history, and DataGrip-style SQL parameter prompts.
- **DataGrip-style completion.** Dialect-aware suggestions for 23 SQL dialects: aliases, qualified
  names, INSERT auto-fill, JOIN generation from foreign keys, live templates and a DataGrip-like
  ranker (match quality, label length, word usage).
- **Results grid.** Quick row filter, click-to-sort on any column, a value viewer that pretty-prints
  JSON, and incremental page fetching for large result sets.
- **Table data editor.** A `WHERE`/`ORDER BY` bar, paging, inline cell edits, add/delete rows, and a
  Submit that applies every pending change inside one transaction. Views and keyless tables stay
  read-only.
- **Exports.** Excel `.xlsx`, CSV (comma), TSV, pipe- and semicolon-separated, JSON, and
  dialect-quoted SQL `INSERT`s — all through native save dialogs. CSV files get a UTF-8 BOM so Excel
  opens accents correctly.
- **ER diagrams.** Schema graphs laid out by ELK with orthogonal edge routing, a table finder,
  neighbour focus, zoom/pan, and SVG / PNG / vector-PDF export.
- **VS Code themes.** Any color theme, file icon theme or product icon theme; installed VS Code /
  VSCodium / Cursor extensions are discovered automatically, and Dark / Light / System modes switch
  between sibling themes.

## Requirements

| | |
|---|---|
| Development | Node.js 18 or newer, npm |
| Running from source, Linux | an X11/Wayland session; `xvfb` only for `npm run smoke` |
| JDBC data sources | Java 11+ on `PATH`, or a `JAVA_HOME` configured in Settings |
| Everything else | bundled (Electron ships Chromium + Node; SQLite runs as WASM, so no native build step) |

## Install

### Ubuntu / Debian (.deb)

Build the package once (from the repository root):

```bash
npm install
npm run build            # bundles out/ (main + preload + renderer)
npm run fetch:jdbc       # optional: bundles the JDBC sidecar JAR
npx electron-builder --linux deb
```

Then install and launch:

```bash
sudo apt install ./dist/stratum_0.1.0_amd64.deb   # artifact name: stratum_<version>_<arch>.deb
stratum
```

`apt` resolves the runtime dependencies (GTK 3, NSS, libsecret and friends) automatically; all of
them ship with a standard desktop installation, so installing with
`sudo dpkg -i dist/stratum_*.deb` also works. The app installs under `/opt/Stratum` with a
`.desktop` entry; `apt remove stratum` uninstalls it.

### Other packages

`npm run dist` builds every target configured for the current OS in `electron-builder.yml`:
AppImage + deb + rpm on Linux, dmg + zip on macOS, NSIS + portable on Windows. Installers must be
built on (or for) each OS.

## Quick start

1. **Add a data source.** Press `Ctrl/⌘+Alt+Shift+D` (or click **New Data Source…** on the welcome
   screen). Pick PostgreSQL, MySQL / MariaDB, SQLite or *Other (JDBC)*, fill in the fields and press
   **Test Connection** before **OK**.
   For SQLite you can also use **File → Open SQLite File…**, point the *File* field at a `.db` path,
   or use `:memory:` for a scratch database.
2. **Browse the schema.** Expand the connection in the side bar: schemas → tables/views → columns
   (PK/FK colored) and indexes. The filter box narrows the tree; arrow keys navigate, `Enter`
   opens. Right-click a table for *Open Data Editor*, *Show Diagram (neighbours)*,
   *Select \* in Console*, *Rename…* and *Find Usages*.
3. **Run SQL.** The console opens automatically per connection. `Ctrl/⌘+Enter` executes the
   statement under the caret, `Ctrl/⌘+Shift+Enter` executes the whole script, `Ctrl/⌘+F2` cancels.
   Parameters such as `:id` or `${table}` prompt before running and are remembered.
4. **Edit data.** The data editor shows 500 rows per page with a `WHERE` / `ORDER BY` bar. Double-click
   a cell to edit, use the toolbar to add/delete rows, then `Ctrl/⌘+Alt+Enter` (Submit) to apply all
   pending changes in one transaction — or Revert to discard them.
5. **Draw the schema.** *Database → Show Diagram* (`Ctrl/⌘+Alt+U`) renders the current data source;
   right-clicking a table offers *Show diagram (neighbours)* to focus on its FK neighbourhood.
6. **Make it yours.** `Ctrl/⌘+K Ctrl/⌘+T` picks a color theme; Settings (`Ctrl+Alt+S`, or `⌘,` on
   macOS) covers fonts, completion, query safety and the JDBC sidecar.

## Supported databases

| Connection type | Driver | Notes |
|---|---|---|
| PostgreSQL | `pg` (bundled) | SSL toggle; read-only enforced with `default_transaction_read_only`. |
| MySQL / MariaDB | `mysql2` (bundled) | SSL toggle; read-only enforced with `session transaction read only`; big numbers arrive as strings. |
| SQLite | `sql.js` (WASM, bundled) | No native modules; file or `:memory:`; writes persist to the file after each write outside an open transaction. |
| Other (JDBC) | jdbc-adapter-server (bundled sidecar) | Any JDBC driver JAR; choose the SQL dialect used for quoting/completion. |

Anything with a JDBC driver already works through the generic JDBC transport. Engines without an ANSI
`information_schema` get catalog-specific introspection instead: Oracle (`ALL_*` dictionary views),
Db2 (`SYSCAT`), SAP ASE (`sysobjects`/`syscolumns`, DataGrip's bit-8 nullability mask), ClickHouse
(`system.*`), Cassandra CQL (`system_schema`) and BigQuery (region-scoped `INFORMATION_SCHEMA`). All
of these paths are covered by tests (`tests/db.test.ts`).

### JDBC sidecar details

- Get the JAR with `npm run fetch:jdbc` (downloads the latest release into
  `resources/jdbc-adapter/`). Alternatively point Stratum at any copy with the `STRATUM_JDBC_JAR`
  environment variable or **Settings → JDBC adapter → Server JAR**.
- One Java process is shared by every JDBC data source; it listens on `127.0.0.1:7823` by default
  (**Settings → Sidecar port**) and is started on demand.
- Java is taken from `PATH` unless **Settings → JAVA_HOME** is set.

## The workbench

The window is the familiar IDE layout:

- **Activity bar** (left or right, see `workbench.sideBar.position`): Database Explorer, New Query
  Console, Diagram, Find Action (`Ctrl/⌘+Shift+A`) and Settings. Hovering shows each action's
  name and shortcut.
- **Side bar:** the Database Explorer tree. Rows show connection state (color-coded), the server
  version, schema table counts, table/view icons, and for columns their data type, `not null`
  marker and PK/FK coloring; indexes show their columns and a `unique` badge.
- **Editor area:** tabs for consoles, table editors and diagrams. Console titles are numbered per
  connection (`shop.db console`, `shop.db [2]`…).
- **Status bar:** the active data source with its version, and the active color theme (click to
  change it).

The native menu (File / Edit / View / Run / Database / Help) exposes the same commands as the UI.
A tray icon shows or hides the window where the platform supports it, and all database sessions are
closed cleanly on quit.

## SQL completion

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

The Settings dialog can disable completion, turn off "suggest on space", enable automatic table
aliases, disable FK joins or live templates, and choose the keyword case (`UPPERCASE`, `lowercase`
or keep as typed).

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

## Query console

- **Execution.** `Ctrl/⌘+Enter` runs the statement under the caret (with DataGrip's fallback to the
  preceding statement when the caret sits in blank space); `Ctrl/⌘+Shift+Enter` runs the whole
  buffer as a script. A statement that returns rows can be cancelled with `Ctrl/⌘+F2`.
- **SQL parameters.** `:name`, `:'name'`, `:"name"` (on dialects whose clients accept bind-style
  parameters — the PostgreSQL family, Oracle, Db2, H2, SQLite…), plus `${name}`, `$(name)` and
  `#name#` everywhere. A prompt collects the values before execution; quoted forms insert an
  escaped SQL literal, bind-style `:name` keeps numbers/NULL bare and quotes text, script forms
  substitute verbatim. Values are remembered per parameter name. The whole feature can be turned
  off with `query.parameters.enabled`.
- **Safety.** `query.confirmDestructive` (on by default) asks before running `UPDATE` / `DELETE`
  without a `WHERE` clause.
- **History.** Every executed statement is remembered per connection (newest first, toggle button in
  the toolbar); clicking an entry inserts it at the cursor.
- **Paging.** Results fetch `query.pageSize` rows (default 100) at a time; the results footer offers
  **Fetch next N** and **Fetch all** (capped at 50 pages per click, cancellable). The meta line
  shows `rows[+] · duration`.

## Results grid

Each statement's output gets its own result tab (error / table / checkmark icon), with:

- **Filter rows** — matches anywhere, case-insensitive, across every column (including inside JSON
  payloads). `Escape` clears it.
- **Column sort** — click a header to cycle ascending → descending → unsorted. Numbers sort
  numerically (including numeric-looking strings from drivers), nulls go last ascending, ties keep
  their original order.
- **Value viewer** — open a cell to see its full value; JSON payloads are pretty-printed and the
  whole text is copyable. `Escape` closes.
- **Grid** — windowed rendering for large results, resizable columns, a cell cursor, and copying of
  selected cells as TSV.
- **Errors** render as text under the tab instead of dialogs, and a failed incremental page fetch
  keeps the rows already loaded and shows the error in the footer.

## Table data editor

The data editor is data-centric: a `WHERE` and an `ORDER BY` input above the grid (both support bare
fragments, e.g. `id > 10` and `created_at desc`), 500 rows per page with Previous/Next.

- **Inline editing.** Double-click a cell, type, `Enter` commits into the pending-edit set
  (highlighted until submitted). Add row / Delete row operate on the current page; deleted rows are
  marked rather than hidden until you submit or revert.
- **Submit** (`Ctrl/⌘+Alt+Enter`) builds `UPDATE` / `DELETE` / `INSERT` statements with the
  connection's dialect quoting, keyed by the table's primary key, and applies them all inside one
  transaction — if anything fails, everything rolls back and the error is shown. The button label
  counts pending changes.
- **Read-only fallback.** Views and tables without a primary key (or sources with the read-only flag)
  open in a read-only grid with an explanatory hint.
- **Exports** use exactly what is on the grid (current page plus pending inserts).

## Exporting data

The export menu (results pane and data editor) offers DataGrip's CSV family plus JSON, SQL and Excel:

| Format | Notes |
|---|---|
| Excel (`.xlsx`) | Written natively (no dependency): typed cells, bold frozen header, sheet named after the table. |
| CSV (comma-separated) | "As-needed" quoting, LF records, UTF-8 BOM so Excel keeps accents. |
| Semicolon-separated | Same rules as CSV, for locales where `;` is the list separator. |
| TSV (tab-separated) | No BOM. |
| Pipe-separated | `.txt` files. |
| JSON | Pretty-printed array of objects keyed by column name. |
| SQL INSERTs | One statement per row, identifiers and literals quoted for the connection's dialect. |

Every export goes through a native save dialog; the [ERD](#entity-relationship-diagrams) has its own
image export menu.

## Entity-relationship diagrams

The ERD view renders a compact schema map: graph build → ELK layered placement → own orthogonal edge
routing → a pure SVG renderer (all of it testable without a browser, see `tests/db.test.ts`).

- **Toolbar:** fit to window (`0`), zoom out (`−`), percentage (click resets to 100%), zoom in (`+`),
  *Types* (show column types), *Views* (include views), *Refresh schema*, and *Export*; the right
  side shows `N tables · M relations`.
- **Finder:** type in the search box to highlight matching tables and see the hit count; clicking a
  node selects it.
- **Navigation:** the wheel/two-finger scroll pans; `Ctrl/⌘+wheel` (and trackpad pinch) zooms at the
  pointer; `+`/`-` zoom from the keyboard; `Escape` clears selection, search and menus. Resizes keep
  the diagram fitted until you pan or zoom by hand.
- **Context menu on a table:** open its data editor, copy the qualified name, or open a *neighbours*
  diagram with only its FK neighbourhood. Opening a diagram from the Explorer focuses the same way.
- **Exports:** SVG, PNG at 1× / 2× / 4×, and a single-page vector PDF sized to the diagram — with an
  optional transparent background for SVG and PNG. Exported files always use the standalone light
  palette on white, whatever theme the workbench uses.

## Themes and appearance

Any VS Code color theme, file icon theme or product icon theme works:

- **Built-ins** in `themes/`: Carbon Dark / Light (improved) and Min Dark / Light color themes, plus
  Carbon Product Icons Outline / Solid.
- **Drop-ins** in `<userData>/themes` — plain `.jsonc` or `.json` files.
- **Extensions:** installed VS Code / VSCodium / Cursor extensions are discovered automatically
  (their `contributes.themes`, `contributes.iconThemes` and `contributes.productIconThemes`), with
  `include` chains inlined and `vsix` icon fonts referenced through a restricted `stratum-asset://`
  protocol. Duplicates collapse, with local files winning over extension copies.

Colors become `--vscode-*` CSS variables (same names as VS Code), sparse third-party themes get
sane fallbacks for borders and scrollbars, and the Monaco theme is derived from the theme's
`tokenColors`. File icon themes resolve their icons (glyph or image) against the theme base, and
product icon themes re-map codicon glyphs.

**Appearance modes** (`appearance.mode`): Dark and Light pin a kind, System follows the OS live.
Switching modes moves to the active theme's sibling when one exists ("Min Dark" ↔ "Min Light",
"Carbon Dark" ↔ "Carbon Light") and falls back to the bundled Carbon theme of that kind. Picking a
theme explicitly pins its kind, like VS Code. `scripts/improve-themes.py` regenerates the improved
Carbon themes (visible borders, `tree.tableColumnsBorder`, `charts.*`) from the originals.

## Settings

Settings live in `<userData>/settings.json` and are editable both in the dialog (`Ctrl+Alt+S`, macOS
`⌘,`) — Appearance, Editor, SQL completion, Query execution, JDBC adapter, and a raw-JSON mode with
validation — and directly as JSON. Unknown keys pass through untouched; known keys are coerced to
safe values, and *Restore defaults* resets everything.

| Key | Default | Meaning |
|---|---|---|
| `appearance.mode` | `system` | `dark` / `light` pin a theme kind; `system` follows the OS. |
| `workbench.sideBar.position` | `left` | `left` / `right`; moves activity bar and side bar together. |
| `editor.fontFamily` | `""` | Monospace family; empty keeps the built-in chain (JetBrains Mono, SF Mono…). |
| `editor.fontSize` | `13` | 8–32. |
| `editor.tabSize` | `2` | 1–8. |
| `editor.wordWrap` | `off` | `on` / `off`. |
| `editor.minimap` | `false` | Monaco minimap. |
| `completion.enabled` | `true` | Master switch for SQL completion. |
| `completion.suggestOnSpace` | `true` | DataGrip-style suggestions after a space. |
| `completion.autoAlias` | `false` | Add aliases when completing table names. |
| `completion.snippets` | `true` | Live templates (`sel`, `ins`, `upd`…). |
| `completion.joinByForeignKey` | `true` | Generate JOIN clauses from foreign keys. |
| `completion.keywordCase` | `upper` | `upper` / `lower` / `preserve`. |
| `query.pageSize` | `100` | Rows fetched per page, 10–10000. |
| `query.confirmDestructive` | `true` | Ask before `UPDATE` / `DELETE` without `WHERE`. |
| `query.parameters.enabled` | `true` | Prompt for SQL parameters before running. |
| `query.parameters.values` | `{}` | Remembered parameter values, keyed by name. |
| `query.history` | `{}` | Per-connection console history (newest first). |
| `jdbc.port` | `7823` | Sidecar port (restarts the sidecar on change). |
| `jdbc.jarPath` | `""` | `jdbc-adapter-server.jar` location; empty uses the bundled copy or `STRATUM_JDBC_JAR`. |
| `jdbc.javaHome` | `""` | Java home for the sidecar; empty uses `java` from `PATH`. |
| `colorTheme`, `fileIconTheme`, `productIconTheme`, `colorScheme`, `windowBackground` | — | Managed by the theme manager. |

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/⌘+Alt+Shift+D` | New Data Source… |
| `Ctrl/⌘+Shift+L` | New Query Console |
| `Ctrl/⌘+Alt+Y` | Refresh the Database Explorer |
| `Ctrl/⌘+Alt+U` | Show Diagram for the current data source |
| `Ctrl/⌘+Enter` | Execute the statement under the caret |
| `Ctrl/⌘+Shift+Enter` | Execute the whole script |
| `Ctrl/⌘+F2` | Cancel the running statement |
| `Ctrl/⌘+Alt+Enter` | Submit pending grid changes |
| `Ctrl/⌘+Shift+A` | Find Action (command palette) |
| `Ctrl/⌘+1` | Focus the Database Explorer |
| `Ctrl/⌘+4` | Toggle the results panel |
| `Ctrl/⌘+K` then `Ctrl/⌘+T` | Color Theme picker |
| `Ctrl+Alt+S` (macOS `⌘,`) | Settings |

File Icon Theme… and Product Icon Theme… live in the View menu (no default accelerator). In the ERD,
`0` fits, `+`/`-` zoom and `Escape` clears; in the Explorer, arrow keys navigate and `Enter` activates.

## Where your data lives

All application state lives under Electron's per-user data directory (`~/.config/Stratum` on Linux,
`~/Library/Application Support/Stratum` on macOS, `%APPDATA%\Stratum` on Windows):

| Path | Contents |
|---|---|
| `connections.json` | Data source configs, written atomically (temp file + rename). Passwords are sealed with the OS keychain (`safeStorage`) when available. |
| `settings.json` | Everything in the [Settings](#settings) table. |
| `themes/` | Drop-in VS Code themes (color, file icon, product icon). |

SQLite files are modified in place by the SQLite transport (written after each statement that
changes data, outside open transactions).

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

**Process model.** The renderer is a normal web app with no Node access: everything crosses a single
typed, request/response API (`src/shared/ipc.ts` → `window.stratum`) exposed by the preload script
over `ipcRenderer.invoke`. The main process pushes menu commands back as a `command` event.
Typed data ends where drivers begin: `normalize.ts` converts BigInt, Date, binary and object values
into JSON-safe representations once, at the IPC boundary. Database errors are *results*
(`QueryResult.error`), never exceptions thrown at the UI.

**Transport × Dialect.** Two orthogonal interfaces (`src/main/db/types.ts`):

- a **Transport** moves SQL to a database and rows back (`open` / `query` / `cancel` / `close`) and
  knows nothing about SQL dialects;
- a **Dialect** knows SQL text for one database family (`quote`, `qualify`, `paginate`,
  `introspect`) and knows nothing about wire protocols.

A `DbSession` (`src/main/db/session.ts`) composes one of each and adds policy: result paging
(`DEFAULT_PAGE` 500), read-only enforcement, error shaping, and transactional `submit`.

Add a database = one Transport (if it needs a new wire protocol) and/or one Dialect, registered in
`db/factory.ts` — the only place that knows which transport/dialect pairs exist. Anything with a
JDBC driver already works through the generic JDBC transport.

**Services.** `ConnectionManager` owns live sessions per data source (open / close / test).
`JdbcSidecar` owns the single shared Java process behind the JDBC transport. `ThemeService` lists,
reads and imports themes and constrains the `stratum-asset://` protocol to theme roots.
`JsonStore` is the atomic JSON persistence used for both connections and settings,
with `safeStorage` password sealing.

**Shared contracts.** `src/shared` has no runtime dependencies and is imported by all three
processes: the SQL splitter (`sql.ts`, with DataGrip's statement-at-caret semantics), the DML
generator (`sqlgen.ts`), quoting rules (`quoting.ts`), SQL parameters (`sqlParams.ts`), the
completion engine and ranker (`sqlComplete.ts`, `sqlRank.ts`), the result-view helpers
(`gridView.ts`), the export writers (`export.ts`, `xlsx.ts`) and the settings schema (`settings.ts`).
That is what makes the non-UI half of the app unit-testable in plain Node.

## Development

```bash
npm install
npm run dev            # electron-vite dev with HMR
npm run build          # bundle out/ (used by packaging and smoke)
npm run typecheck      # tsc --noEmit
npm test               # vitest: unit + SQLite end-to-end tests
npm run smoke          # builds, then drives the real app headless (needs xvfb)
npm run fetch:jdbc     # optional: download jdbc-adapter-server.jar
npm run pack           # unpacked app directory (electron-builder --dir)
npm run dist           # installers for the current OS
```

`npm run dev` hot-reloads the renderer and restarts the main process on change. `npm run smoke` sets
`STRATUM_SMOKE` to `scripts/smoke.js`, launches Electron under `xvfb-run --no-sandbox --disable-gpu`
and runs a scripted UI flow: it exercises the welcome screen, creates an in-memory SQLite database
with related tables, runs console queries, opens the table editor, drives the ERD finder, and
switches themes — surfacing everything found through the smoke hook (`?smoke=1` exposes
`window.__wb` and `window.__themes`).

## Testing

`npm test` runs Vitest in a Node environment over `tests/**/*.test.ts`:

| Suite | Covers |
|---|---|
| `db.test.ts` | DbSession paging, errors-as-results, transactional submit, read-only; introspection of tables/views/PKs/FKs/indexes; ERD layout, overlap and themed SVG; engine-specific introspection (Oracle, ClickHouse, Cassandra, SAP ASE, Db2) against a fake runner. |
| `sql.test.ts` | Statement splitting (quotes, dollar-quoting, comments), caret semantics, `returnsRows`, DML generation. |
| `sqlComplete.test.ts` | Alias scoping, qualified names, INSERT auto-fill, FK join generation, preferences, dialect catalogs and template gating. |
| `sqlRank.test.ts` | Ranking signals: exact/prefix/middle/greedy, shorter labels, usage lift, bucket dominance. |
| `phase2.test.ts` | SQL parameter patterns and substitution; export formats (BOM, quoting, JSON, dialect-quoted INSERTs). |
| `gridView.test.ts` | Row filtering and column sorting (numbers, nulls, stability). |
| `settings.test.ts` / `store.test.ts` | Settings coercion and dialog preview semantics. |
| `theme.test.ts` | Color resolution and CSS vars, catalog dedupe, appearance modes and siblings, Monaco conversion, file/product icon themes. |
| `fonts.test.ts` / `xlsx.test.ts` | Font stacks; the XLSX writer (CRC-32, refs, sheet names, OOXML package, escaping, base64 round-trip). |

The smoke run complements them with an end-to-end pass through the real Electron renderer.

## Packaging installers

`electron-builder.yml` drives packaging:

- **App id** `dev.stratum.app`; app files are `out/**` plus `package.json`, with the `sql.js` WASM
  unpacked from the asar so it can be loaded.
- **Extra resources:** `themes/`, `resources/jdbc-adapter/` (populated by `npm run fetch:jdbc`) and
  the brand icons (window icon, tray icons including the macOS template variants).
- **Targets:** macOS `dmg` + `zip` (hardened runtime), Windows `nsis` + `portable`, Linux
  `AppImage` + `deb` + `rpm` (category *Development*, `StartupWMClass=stratum`).
- **deb dependencies:** the top-level `deb` block overrides electron-builder's default list to drop
  the legacy `libxss1` hard dependency — the packaged Electron neither links nor `dlopen`s
  `libXss.so.1`, so requiring it only made `dpkg -i` fail on distributions that no longer ship the
  library (Ubuntu 26.04) — and keeps `libxss1` and `libappindicator3-1` (tray indicator) as
  `Recommends`.

The deb/rpm metadata (maintainer, homepage) comes from `author` and `homepage` in `package.json`.
Running a single target is fine too:

```bash
npx electron-builder --linux deb    # dist/stratum_<version>_<arch>.deb
npx electron-builder --linux rpm
npx electron-builder --mac dmg      # must run on macOS
```

## Project layout

```
src/
  shared/          contracts + pure logic, no runtime deps
    types.ts         domain types (drivers, dialects, catalog, results, themes)
    ipc.ts           StratumApi — the typed renderer<->main contract
    sql.ts           statement splitter, caret semantics, line-comment stripping
    sqlComplete.ts   DataGrip-style completion engine
    sqlRank.ts       completion ranking signals
    sqlDialectData.ts  generated keyword/function catalogs for 23 dialects
    sqlgen.ts        UPDATE/DELETE/INSERT builders for the data editor
    sqlParams.ts     SQL parameter patterns and substitution
    quoting.ts       dialect identifier quoting
    gridView.ts      result filtering and sorting
    export.ts        CSV/TSV/pipe/semicolon/JSON/INSERT writers
    xlsx.ts          native OOXML workbook writer
    settings.ts      settings schema, defaults and coercion
  main/
    index.ts         app lifecycle, window, tray, stratum-asset:// protocol
    ipc.ts           IPC channel registration
    menu.ts          native menu template (all accelerators)
    brand.ts         brand asset paths
    db/
      types.ts       Transport and Dialect interfaces
      session.ts     DbSession: paging, read-only, submit transactions
      factory.ts     the only transport/dialect registry
      dialects.ts    introspection SQL per dialect family
      normalize.ts   driver values -> JSON-safe values
      transports/    sqlite.ts · postgres.ts · mysql.ts · jdbc.ts
    services/
      connectionManager.ts  live sessions per data source
      store.ts              atomic JsonStore + safeStorage password sealing
      themeService.ts       theme discovery, import and asset protocol roots
      jdbcSidecar.ts        shared jdbc-adapter-server process
  preload/index.ts  contextBridge: window.stratum
  renderer/src/
    App.tsx           workbench layout, menu commands, command palette actions
    main.tsx          bootstrap; smoke hook under ?smoke=1
    monaco.ts         Monaco setup, completion provider, theme sync
    store/workbench.ts  zustand store: connections, tabs, runs, params, paging
    theme/            colorTheme · fileIconTheme · productIconTheme · monacoTheme · fonts · themeManager
    erd/erd.ts        graph build, ELK layout, orthogonal routing, SVG render
    workbench/        Explorer · ConsoleEditor · ResultsPane · DataGrid · ValueDialog ·
                      TableEditor · ErdView · ExportMenu · DatasourceDialog · SettingsDialog ·
                      ParamDialog · CommandPalette · Tabs · Icon/iconMap/lucide
    styles.css        workbench CSS built on the --vscode-* variables
tests/               vitest suites (see Testing)
scripts/             maintenance tools (see below)
themes/              built-in color and product icon themes
fonts/               Carbon product icon fonts (woff2)
resources/jdbc-adapter/  jdbc-adapter-server.jar (fetched, gitignored)
stratum-brand/       logos, app icons, tray icons, README preview image
```

## Maintenance scripts

| Script | Purpose |
|---|---|
| `scripts/fetch-jdbc-adapter.mjs` | `npm run fetch:jdbc` — download the latest jdbc-adapter-server release JAR. |
| `scripts/datagrip-keywords.mjs` | Decode DataGrip `*Keywords.class` constant pools into JSON. |
| `scripts/datagrip-tokens.mjs` | Decode DataGrip `*Types.class` lexer vocabularies (via `javap`). |
| `scripts/datagrip-catalog.mjs` | Merge keywords, tokens and `functions.xml` into `src/shared/sqlDialectData.ts`. |
| `scripts/lib-classfile.mjs` | Class-file parser shared by the DataGrip extractors. |
| `scripts/vendor-icons.mjs` | Vendor the Lucide glyphs referenced by `iconMap.ts` into `lucide.tsx` (re-run after editing the map). |
| `scripts/improve-themes.py` | Regenerate the improved Carbon color themes (borders, grid keys, chart palette). |
| `scripts/smoke.js` | The UI script executed by `npm run smoke`. |

## Upstream projects

- [database-client/jdbc-adapter-server](https://github.com/database-client/jdbc-adapter-server) (MIT) —
  run as a sidecar over its HTTP API.
- [cweijan/vscode-database-client](https://github.com/cweijan/vscode-database-client) (MIT) — an
  extension tightly bound to the `vscode` API (87 of 165 files import it), so it cannot be embedded;
  Stratum reuses its approach (pg / mysql2 / JDBC bridge, per-dialect SQL).
- JetBrains DataGrip — not a dependency: only factual keyword/function/template names are extracted
  from a locally installed copy (scripts above); no DataGrip code or resources are copied.
- Runtime building blocks: [Electron](https://www.electronjs.org/), [Monaco Editor](https://microsoft.github.io/monaco-editor/),
  [React](https://react.dev/), [zustand](https://zustand-demo.pmnd.rs/), [elkjs](https://github.com/kieler/elkjs),
  [sql.js](https://sql.js.org/), [pg](https://node-postgres.com/), [mysql2](https://github.com/sidorares/node-mysql2),
  [@vscode/codicons](https://github.com/microsoft/vscode-codicons),
  [Carbon product icons](https://github.com/carbon-design-system/carbon/tree/main/packages/icons)
  and [Lucide](https://lucide.dev/) (ISC).

## Troubleshooting

- **"jdbc-adapter-server.jar not found"** — run `npm run fetch:jdbc`, set `STRATUM_JDBC_JAR`, or pick
  the JAR in *Settings → JDBC adapter → Server JAR*.
- **JDBC test fails with a Java error** — install a JRE/JDK (11+) so `java -version` works, or set
  *JAVA_HOME* in Settings.
- **JDBC sidecar port already in use** — change *Settings → Sidecar port*; the sidecar restarts and
  the new port applies from the next JDBC connection.
- **The global menu bar is missing on Linux** — it needs a DBusMenu host (KDE, Unity-style appmenu…);
  every command remains available in the window via Find Action (`Ctrl+Shift+A`).
- **Smoke test fails on a headless machine** — it needs `xvfb` (`xvfb-run`); it also passes
  `--no-sandbox --disable-gpu` for CI containers.
- **Start over** — Settings → *Restore defaults*, or delete `settings.json` / `connections.json`
  under [the user data directory](#where-your-data-lives).

## License

MIT (see `package.json`).
