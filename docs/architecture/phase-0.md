# Phase 0 — Platform foundations

This phase adds the foundations the later DBeaver-style phases build on: a declarative extension
registry, shared i18n, one rotating file logger and a single verification command. It also documents
the stack, folder layout and dependency rules so new modules land in the right layer.

## Stack

- Electron + React + TypeScript renderer, bundled by `electron-vite`.
- Pure domain logic in `src/core`; no Electron, React or Node-only imports there.
- Main-process services own files, sockets, drivers and secrets.
- A Java sidecar (`jdbc-adapter-server`) provides generic JDBC access; PostgreSQL, MySQL and SQLite
  also run through native Node drivers.
- Zustand store composed from slices; features never import each other directly.
- Vitest for unit/regression tests, dependency-cruiser for architecture rules.

## Folder layout

```
src/
  shared/    contract layer: IPC surface, shared types, extension manifests
  core/      pure domain logic: SQL parsing, settings, registry, i18n, profiles, plans
  main/      Electron main: window lifecycle, services, drivers, logger, native menu
  preload/   contextBridge: the only renderer -> main bridge
  renderer/  React workbench: features, store, theme, UI primitives
tests/       node-environment unit tests (no Electron needed unless mocked)
docs/        architecture notes and decisions
```

Dependency direction enforced by `npm run lint:arch`:

```
shared  <-  core  <-  main
   ^         ^
   |         |
preload   renderer
```

- `shared` imports nothing from `core`, `main`, `renderer` or `preload`.
- `core` never imports Electron, React, `main` or `renderer`.
- `main` and `renderer` never import each other; the preload contract is the only bridge.
- Features communicate through the Zustand store or shared UI, never by importing each other.
- IPC routers delegate to services; they do not touch stores or drivers.

## Extension registry

`src/shared/extensions.ts` defines the data-only manifest (`id`, `name`, `version`, `description`,
`kind`, `priority`, `builtin`, `mandatory`, `commands`, `drivers`). `src/core/registry.ts` validates
manifests and resolves conflicts:

- Ids are namespaced lowercase strings; versions are semantic.
- A duplicate id is only accepted with a **strictly higher priority**; otherwise the registry throws
  `DuplicateExtensionError`. This makes overlay order explicit instead of load-order dependent.
- The installed list sorts by priority desc, then name, then id.
- `mandatory` extensions (the workbench itself) cannot be disabled.
- Disabled ids persist in `extensions.disabled` in `<userData>/settings.json`.

`ExtensionService` registers the manifests bundled in `src/main/extensions/builtin.ts` plus the
reference plugin in `src/main/plugins/builtin/example.ts`, then exposes `list` / `setEnabled` over
IPC. The Extensions dialog (`Ctrl+Shift+X`) shows capabilities and toggles them. Loading third-party
code is intentionally out of scope for this phase.

## i18n

- Catalogs: `src/core/i18n/en.ts` (source of truth) and `es.ts` (typed against the English keys, so a
  missing translation fails the build).
- `resolveLocale(setting, systemLanguage)`: `system` follows the OS, any non-Spanish system language
  falls back to English. `app.locale` pins `en` or `es`.
- `translate` falls back from the selected locale to English and finally to the key itself.
- Native menu labels are translated in the main process and rebuilt when `app.locale` changes.
- The renderer hook `useT()` re-renders consumers when the setting changes. Phase 0 translates the
  menu, welcome screen, status line and the new Extensions dialog; older strings migrate per phase.

## Logging

`src/main/logger.ts` provides a single logger with:

- `<userData>/logs/stratum.log`, 2 MiB rotation, three backups (`stratum.log.1` … `.3`).
- Recursive redaction of credential-shaped keys plus URL/`password=` fragments in free text.
- `logger.child('ssh')` scopes for services.
- Crash handlers (`uncaughtException`, `unhandledRejection`) write to the same file.
- Logging never throws: a failed write falls back to one console error.

## Verification

`npm run verify` runs, in order:

1. `npm run typecheck`
2. `npm run lint:arch`
3. `npm test`
4. `npm run build`

CI (`.github/workflows/ci.yml`) calls the same command, so local and remote gates cannot drift.

## Deliberate limits

- Extension code loading, marketplace metadata and install/uninstall are later work.
- Only English and Spanish catalogs exist; untranslated legacy screens stay in English.
- The logger writes synchronously; volume is low (lifecycle events, warnings, crash reports) and
  correctness during a crash matters more than throughput.
