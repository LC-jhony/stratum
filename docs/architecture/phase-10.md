# Phase 10 — Spatial values, extra engines and packaging

Closing slice of the approved plan: the cell viewer learns to draw spatial values, the JDBC
transport gains declarative presets instead of one-off integrations, and the proxy helper that
Phase 7 left pending is implemented. Cross-platform packaging already existed and is now part of
the documented contract.

## Spatial values (`src/core/gis.ts`)

The parser is pure and dependency-free, so recognising a geometry never loads a map library:

- **WKT** — `POINT`, `LINESTRING`, `POLYGON`, the three `MULTI*` types and `GEOMETRYCOLLECTION`,
  with an optional `SRID=4326;` prefix and optional `Z` / `M` / `ZM` ordinates. Extra ordinates
  are dropped; the first two are the plane coordinates.
- **GeoJSON** — objects and JSON text, including `Feature` and `FeatureCollection`.
- **WKB** — hex text, little- or big-endian, including EWKB SRIDs and ISO `Z` type codes.

All three produce one `Geometry` tree. `MAX_POSITIONS` (200,000) caps a single value, so a hostile
WKB count cannot exhaust memory; a value over the cap is simply not rendered.

`projectGeometry` fits the bounds into a 560×320 SVG with 14 px padding, keeps the aspect ratio,
inverts Y (screen coordinates grow downwards) and centres a single point. Empty collections render
an empty canvas without throwing. Coordinates are treated as a **plane**: there are no tiles and no
reprojection, and the footer says so, which is enough to recognise a shape without pretending to
be a GIS application.

**UI**: `ValueDialog` checks `looksLikeGeometry`, then offers **Map** and **Text** tabs and opens
Map first. Shapes are local SVG (`polygonPath`, `<polyline>`, `<circle>`) styled by `.gis-*` in
`styles.css`; holes use `fill-rule="evenodd"`. The viewer is reachable from the result grid
(double-click a cell) and from the Table Editor toolbar (*View the selected cell*), which now
tracks the cursor through `DataGrid.onSelectCell`.

## Extra engines (`src/core/engines.ts`)

`ENGINE_PRESETS` is a declarative table: id, label, SQL dialect, JDBC URL template, default port and
driver-class hint. It ships 17 presets — H2, DuckDB, Snowflake, BigQuery, Redshift, Trino, Vertica,
Teradata, HSQLDB, Apache Derby, Firebird, Greenplum, CockroachDB, Exasol, SAP ASE, Hive and Spark
SQL. Adding an engine is one row plus its dialect; there is no per-engine plugin.

The data-source dialog exposes them under **More engines**. Picking one switches the source to
JDBC and fills the URL, port, driver class and dialect. `urlForEngine` keeps a URL the user typed
for the same engine, but replaces a URL that belonged to another engine, so switching presets never
leaves a `jdbc:postgresql://` URL under a DuckDB label.

New dialect ids — `duckdb`, `trino`, `teradata`, `firebird` — were added to `DialectId`,
`DIALECTS`, the language table and completion. They run through the existing generic JDBC
transport; query plans for them fall back to textual plans.

## Connection helper — SOCKS5 / HTTP proxy (`src/main/services/proxy.ts`)

A proxy is a connection helper, like the SSH tunnel: the session runs against a **rewritten copy**
of the connection config whose address is `127.0.0.1:<local port>`, so no transport knows a proxy
exists.

- **One listener per data source id**, bound to `127.0.0.1:0`, refcounted and
  promise-deduplicated. Concurrent opens share it; the last release closes it and destroys the
  sockets it still owns. Each accepted socket opens **its own** SOCKS5 / HTTP CONNECT tunnel —
  nothing is multiplexed, which is what proxies expect.
- **SOCKS5** supports no-auth and username/password (method `0x02`, 255-byte credentials), IPv4,
  IPv6 and domain targets. `ipv6Bytes` expands `::`, an embedded IPv4 tail and a zone id. `BND.ADDR`
  is consumed before the database bytes flow, and SOCKS reply codes become readable errors
  (`connection refused`, `host unreachable`, `not allowed by the proxy rules`, …).
- **HTTP CONNECT** sends `CONNECT host:port`, `Host`, `Proxy-Connection` and optional
  `Proxy-Authorization: Basic`. Only a 2xx status is accepted; anything else reports the status and
  reason. Response headers are capped at 64 KB.
- The handshake has a 15-second timeout (`PROXY_TIMEOUT_MS`), and every failure names the endpoint:
  proxy unreachable, credentials rejected, tunnel refused, missing host, invalid port.

**Composition** (`SessionFactory.createWithTunnel`): the SSH tunnel wins when enabled, otherwise
the proxy is acquired; `session.close()` releases the helper. `closeAllProxies()` is the test/quit
hook. `tunnelTarget`, `rewriteForTunnel` and the target rules are shared with the SSH helper: one
host:port, no `+srv` DNS resolution, no multi-host strings, no unix sockets, one Kafka broker.
TLS hostname verification keeps the behaviour of the SSH path.

**Mutual exclusion**: both helpers rewrite the same address, so a data source cannot enable both.
`acquireProxy` and `acquireTunnel` reject the combination with
`This data source has both an SSH tunnel and a proxy enabled; disable one of them.` The dialog
turns the other helper off and explains why. SQLite is rejected: it opens a local file.

**Secrets**: `proxy.password` follows the same rules as every other credential. The IPC schema
validates fields and bounds; `connectionView` returns `hasPassword` and no password; `save` seals it
with the OS keychain and keeps the stored value when the field is blank; `get` unseals it for the
main process only. Export/import keeps type, host, port and user, and strips the password and every
`has*` flag.

## Packaging and updates

`electron-builder.yml` is the single packaging contract:

| Platform | Targets | Notes |
| --- | --- | --- |
| Linux | AppImage, deb, rpm | stable asset names; deb depends list drops the unused `libxss1` hard dependency; `afterInstall` fixes the sandbox helper |
| Windows | NSIS, portable | stable names `stratum_setup.exe`, `stratum_portable.exe` |
| macOS | dmg, zip (universal) | hardened runtime, minimum macOS 13 |

`extraResources` ships the theme catalogue, the JDBC adapter, the window icon and tray icons.
`asarUnpack` keeps the SQLite WASM loadable. `publish` embeds `app-update.yml`, which is what
`electron-updater` reads.

`.github/workflows/release.yml` gates a tag against `package.json`, then runs Linux (ubuntu-22.04),
Windows (`windows-latest`) and macOS (`macos-15`) jobs: typecheck, `fetch:jdbc`, build, package,
upload artifacts, checksum and publish the GitHub Release. Signing and notarisation read optional
secrets; without them the jobs warn and produce unsigned installers.

## Limitations

- **No SQL debugger.** Breakpoints, stepping, stack frames and variable inspection are not
  implemented. The console runs statements whole, and the scheduled-task runner is not a debugger.
  No dead UI is shown for it; this is a documented gap, not a hidden switch.
- **GIS is recognition, not analysis.** No tiles, reprojection, SRID transforms, raster or 3D;
  geographic coordinates are drawn planar and the viewer states it. Values over 200,000 positions
  are not rendered.
- **Proxy scope.** SOCKS5 and HTTP CONNECT only; no SOCKS4, HTTPS proxies or chaining a proxy
  through SSH. One helper per data source.
- **Where artifacts are built.** macOS and Windows installers can only be produced by CI; a local
  Linux machine cannot build them. Without signing secrets the released files are unsigned and may
  trigger Gatekeeper or SmartScreen.
- **Proxy verification.** The helper is tested against in-process SOCKS5 and HTTP proxies. Real
  corporate proxies differ in authentication and allow-lists, so first use against one should be
  checked with **Test** in the dialog.

## Verification

- `tests/gis.test.ts` (13) covers WKT, GeoJSON, WKB/EWKB, recognition heuristics and projection.
- `tests/engines.test.ts` (5) checks unique ids, one dialect per preset, JDBC URLs, default ports
  and URL replacement when the engine changes.
- `tests/proxy.test.ts` (11) runs real sockets through a fake SOCKS5 and HTTP proxy: byte
  round-trips, credential success and failure, one listener shared by two opens, release semantics,
  IPv6 encoding and actionable errors.
- `tests/connectionStore.test.ts` and `tests/connectionTransfer.test.ts` cover proxy sealing,
  blank-password preservation, import/export stripping and disabled-helper topology.
- Full suite: **607 passed, 42 skipped** (66 files passed, 10 skipped); `npm run typecheck`,
  `npm run lint:arch` and the production build are green (`npm run verify`).
- Wayland smoke (15 steps, fresh config, `errors: []`): icons render as 70 SVGs and 0 codicon
  glyphs; the new data-source step finds 18 engine options, fills DuckDB's
  `jdbc:duckdb:stratum.duckdb` / `org.duckdb.DuckDBDriver` / `duckdb` dialect, enables SOCKS5 on
  port 1080, keeps the helper enabled when switching to HTTP (port 3128), and confirms that
  enabling the SSH tunnel disables the proxy with an explanatory note.
