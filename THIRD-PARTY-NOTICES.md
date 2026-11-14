# Third-party notices

Stratum itself is released under the MIT license (see [LICENSE](LICENSE)). It bundles the runtime
dependencies below; each one keeps its own license and copyright. The authoritative license text for
every package ships in `node_modules/<package>/LICENSE*` and in the packaged application, and is also
available from the upstream repositories linked here.

## Bundled runtime dependencies

| Package | Version | License | Upstream |
|---|---|---|---|
| `@aws-sdk/client-s3` | 3.1152.0 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3 |
| `@vscode/codicons` | 0.0.46-24 | CC-BY-4.0 | https://github.com/microsoft/vscode-codicons |
| `basic-ftp` | 6.2.3 | MIT | https://github.com/patrickjuchli/basic-ftp |
| `cassandra-driver` | 4.10.0 | Apache-2.0 | https://github.com/datastax/nodejs-driver |
| `dockerode` | 5.0.1 | Apache-2.0 | https://github.com/apocas/dockerode |
| `electron-updater` | 6.8.11 | MIT | https://github.com/electron-userland/electron-builder |
| `elkjs` | 0.12.0 | EPL-2.0 | https://github.com/kieler/elkjs |
| `ioredis` | 6.0.0 | MIT | https://github.com/redis/ioredis |
| `jsonc-parser` | 3.3.1 | MIT | https://github.com/microsoft/node-jsonc-parser |
| `kafkajs` | 2.2.4 | MIT | https://github.com/tulios/kafkajs |
| `monaco-editor` | 0.57.0 | MIT | https://github.com/microsoft/monaco-editor |
| `mongodb` | 7.7.0 | Apache-2.0 | https://github.com/mongodb/node-mongodb-native |
| `mysql2` | 3.24.6 | MIT | https://github.com/sidorares/node-mysql2 |
| `pg` | 8.23.1 | MIT | https://github.com/brianc/node-postgres |
| `react` / `react-dom` | 19.3.1 | MIT | https://github.com/facebook/react |
| `sql-formatter` | 15.9.0 | MIT | https://github.com/sql-formatter-org/sql-formatter |
| `sql.js` | 1.15.0 | MIT | https://github.com/sql-js/sql.js |
| `ssh2` | 1.17.0 | MIT | https://github.com/mscdex/ssh2 |
| `zod` | 4.6.7 | MIT | https://github.com/colinhacks/zod |
| `zustand` | 5.0.15 | MIT | https://github.com/pmndrs/zustand |

Transitive dependencies keep the licenses declared in their own packages; `npm ls --all` (or the
lockfile) enumerates them for a given build.

## Assets and optional components

- **Carbon product icon fonts** (`fonts/*.woff2`) — Apache-2.0, © IBM
  (https://github.com/carbon-design-system/carbon).
- **VS Code Codicons** (`@vscode/codicons`) — CC-BY-4.0, © Microsoft. The attribution above applies
  to the icon glyphs shipped in the app.
- **jdbc-adapter-server** (`resources/jdbc-adapter/`, fetched separately by `npm run fetch:jdbc`) —
  © the database-client project; see its repository for the license terms
  (https://github.com/database-client/jdbc-adapter-server).
- **Electron and Chromium** — Electron is MIT-licensed; Chromium and its components ship under their
  own BSD-style and third-party licenses. Both are distributed with the packaged application, where
  their full license files are available (`LICENSES.chromium.html`, Electron's `LICENSE`).

## Theme files

Themes under `themes/` and themes imported from installed VS Code / VSCodium / Cursor extensions keep
the license of their respective authors. They are loaded at runtime and are not part of Stratum's
MIT-licensed source.
