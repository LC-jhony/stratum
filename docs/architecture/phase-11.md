# Phase 11 — Connection diagnostics and glass workbench

Two approved slices in one phase: the P1–P4 connection layer (DBeaver-informed) and the
Valet-inspired visual redesign. The SQL debugger that follows builds on both.

## P1 — Structured connection test (`src/core/diagnostics.ts`)

`ConnectionTestResult` now carries `latencyMs`, `version`, `driver`, and — on failure — a stable
`code`, the `stage` where it failed, the driver message and one actionable `hint`. The dialog shows
`Connected in 42 ms · 16.4 · pg`, or `error — hint`; it no longer asks the user to parse a driver
stack. Driver messages are passed through `redactSecrets` before crossing IPC, because JDBC errors
can echo URLs with user-info or `password=` parameters.

The classifier is pure and rule-ordered, so specific messages beat broad words:

| code | examples |
| --- | --- |
| `bootstrap` | `Session setup failed`, init SQL, default schema/catalog, isolation |
| `driver` | `No suitable driver`, `ClassNotFound`, missing JAR |
| `dns` | `ENOTFOUND`, `getaddrinfo`, unknown host |
| `refused` | `ECONNREFUSED`, `connection refused` |
| `unreachable` | `EHOSTUNREACH`, `ENETUNREACH`, no route |
| `timeout` | `ETIMEDOUT`, server selection timeout, adapter deadline |
| `tls` | certificate, self-signed, handshake, verify |
| `auth` | password authentication, access denied (MySQL 1045), `28P01`, `ORA-01017` |
| `database` | unknown database, `3D000`, `1049` |
| `readonly`, `file`, `proxy`, `tunnel`, `invalid` | the remaining distinct causes |

`ConnectionManager.test` knows the stage it is in: the SSH tunnel or proxy is acquired **before**
the database socket opens, so a helper failure is reported as `tunnel`/`proxy` even when its message
mentions authentication. `driverLabel` prefers the configured JDBC class over the adapter name.

## P2 — Bootstrap parity and deadlines

`SessionConfig` gained three fields, validated by the IPC schema:

- **`connectTimeoutMs`** — applied to `pg` (`connectionTimeoutMillis`), `mysql2` (`connectTimeout`),
  MongoDB (`serverSelectionTimeoutMS`), Redis (`connectTimeout`) and the JDBC sidecar's `/connect`
  request. The old hard-coded 10 s remains the fallback.
- **`validationTimeoutMs`** — `DbSession.validate()` races the keep-alive ping against a deadline
  (default `DEFAULT_VALIDATION_TIMEOUT_MS = 15 s`). A half-open socket can no longer hang the idle
  sweep; a timeout closes the session and reports `lost`.
- **`ignoreInitErrors`** — DBeaver's switch. `DbSession.open()` prefixes session-setup failures with
  `Session setup failed:`; without the flag the open rejects (and the classifier explains it), with
  the flag the failure is logged and the already-open connection stays usable.

SQLite now applies `PRAGMA query_only = ON` when `readonly` is set, a second guard below the
`DbSession` write check. PostgreSQL (`default_transaction_read_only`) and MySQL
(`session transaction read only`) already had theirs.

## P3 — Profile-aware transaction defaults (`src/core/profiles.ts`)

Each preset now carries `autoCommit`: **Development = on**, **Test/Production = off**. The dialog
applies the preset when the user selects a profile — for new and edited data sources — and shows a
`Use profile default` link whenever the switch differs from the preset. Explicit choices win;
clearing the profile keeps the last choice. Existing stored configurations are not rewritten:
nothing changes until the user edits the profile or presses the reset link.

## P4 — Live URL/DSN preview (`src/core/connectionPreview.ts`)

The dialog renders a one-line preview above the footer, with a Copy pill:

- PostgreSQL/MySQL URLs include user, IPv6 brackets, port, database, and `sslmode`/`ssl-mode`
  when SSL is on (`verify-full` / `VERIFY_IDENTITY` when verification is enabled).
- MySQL/PostgreSQL unix sockets use `mysql+unix://` and `postgresql:///db?host=…`.
- SQLite shows `sqlite:<path>` or `sqlite::memory:`; JDBC shows the URL.
- A MongoDB/Redis URI wins over host/port and is displayed with its password masked.
- SSH/proxy helpers appear as a chip: `SSH ops@jump:2222 +1 jump`, `SOCKS5 proxy host:1080`.
- `redactSecrets` masks URL user-info passwords and `password`, `pwd`, `secret`, `token`,
  `api_key`, `access_token` and `sslkeypassphrase` query parameters. Passwords never reach the
  preview string, so Copy cannot leak one.

## Design — Valet-inspired glass layer

`styles.css` keeps the original tokens and receives one scoped layer at the end, so third-party VS
Code themes keep working.

- **Aurora**: a single `::before` behind the shell, red/violet/teal radial gradients at 8–24 %
  strength (lower in light themes), isolated under the UI.
- **Glass only on chrome**: title bar, activity rail, side bar, tab strip and status bar are
  translucent with a 20 px backdrop blur. Overlays use the second and only deeper blur (30 px).
- **Opaque reading surfaces**: editor cards, result grids, data grids and toolbars keep the theme
  background. Glass never sits under code or data.
- **Shape**: 18 px cards, 20 px dialogs, 28 px welcome card, pill tabs/buttons/inputs where the
  control is a chip, 8 px window controls. The brand red is the single accent (Carbon's
  `#FF4262` via `--accent-fill`).
- **Welcome** becomes a large glass card with the logo and a hairline keyboard legend.
- **ERD** node radius moved from 9 px to 14 px to match the cards.
- **Dark is the first-run default**: `SettingsService.get()` writes `appearance.mode = 'dark'` when
  the settings file has never chosen one; a pinned theme without a mode keeps its light/dark
  flavour. Saved `dark`/`light`/`system` values win, so existing users are not flipped.
- `prefers-reduced-motion` collapses transitions and animations. `@supports not (backdrop-filter)`
  falls back to opaque chrome. An empty tab bar is hidden instead of rendering an empty pill.

The native window controls are untouched; Linux still draws minimize/maximize/close, macOS keeps
its traffic lights and Windows its caption overlay.

## Verification

- `npm run verify` green: typecheck, dependency-cruiser (176 modules, 563 dependencies), build.
- **627 tests passed / 42 skipped** across 69 passing files. New coverage: 13 preview/diagnostic
  cases, 4 connection-test cases, profile auto-commit defaults, SQLite `query_only`, session-setup
  ignore/prefix, and validation deadline.
- Design smoke (fresh profile, 6 steps, `errors: []`): dark default, aurora, hidden empty tab bar,
  preview with no password, profile → auto-commit off, reset link → preset restored, timeout fields,
  `sslmode=require` after enabling SSL.
- Full regression smoke (15 steps, `errors: []`): logo theme switch, console, ERD search/export,
  grid sort/filter/paging/export, settings, icon resolution (70 svg, 0 codicon), 18 engine presets,
  SOCKS/HTTP/SSH exclusivity.

## Limits and next step

- `backdrop-filter` can degrade to plain translucency when the compositor has no GPU backing; the
  layout and contrast do not depend on the blur.
- macOS and Windows artifacts remain CI-only; no signing secrets are configured.
- Arbitrary JDBC driver properties are still deferred: the bundled adapter accepts fixed fields.
- The SQL debugger is the next phase; this work gives it structured failures and readable chrome.
