# Phase 13 — Appearance and update hardening

A comparison against **Valet Deck 0.1.1** (`/opt/ValetDeck`, shipped `app.asar`, plus its source
tree) showed two models: a small hand-written appearance layer and an explicit, user-driven
updater. Stratum already supported more themes and more install kinds, so this phase does not copy
Valet's shape. It takes the specific things Valet gets right — legible derived colours, themes that
cannot read outside their folders, icons that survive a bad theme, and updater failures a person can
act on — and fixes the equivalents in Stratum.

## Appearance

### Theme catalog: cache, include sandbox, classification

`src/main/services/themeService.ts`

`ThemeService.read()` used to call `list()` and re-read every theme JSON on each switch. With the
bundled file icon themes (~455 kB each) that meant parsing the whole catalog to apply one theme.

- The parsed JSON is cached by absolute path and validated against **mtime + size**. `list()` and
  `read()` share the cache; switching back to a theme parses nothing. Insertion order is refreshed
  on a hit, so the 128-entry map behaves like an LRU, and an edited file invalidates only itself.
- Files above **16 MB** are rejected before parsing.
- `include` chains resolve inside the same `allowedRoots` the `stratum-asset://` protocol serves
  (built-in, user and imported extension folders). An include outside those roots, a cycle, or a
  chain deeper than 8 is an error. The theme is data, not a trusted path.
- `classifyTheme()` uses the icon-theme association keys first (`file`, `fileExtensions`,
  `folderNames`…), then the file name, then the definition shape. Checking `fonts` alone was wrong:
  font-based **file** icon themes also ship `fonts`, and were being classified as product icons.
- `normalizeTheme()` drops fields with the wrong shape (`colors` that is not an object,
  `tokenColors` that is not an array) before the renderer sees them.
- Extension contributions keep their declared **id** (`ext:<extension>:<theme>:<kind>`). Reading an
  extension theme back used to fall through to `abs` with `kind: 'color'`, so the saved selection
  did not survive a restart.
- `list()` sorts file names so the catalog order is stable between runs.

### Contrast repair

`src/renderer/src/theme/contrast.ts`, applied from `colorTheme.ts`

VS Code themes are hand-authored. Carbon paints white on `#FF4262`, which is **3.38:1** — below AA
for a button label. Min's status and activity bars fail at 3.76:1 and 2.48:1 in light mode.

`repairContrast()` runs after the theme's colours and Stratum's fallbacks are merged, so it also
repairs sparse third-party themes. It converts each pair to HSL and moves **only lightness**, in 1 %
steps, until the target is met:

- Filled surfaces (`button`, `statusBar`, `list.activeSelection`) adjust the **background** and keep
  the label colour; the author's accent survives, darkened just enough.
- Text on panels (`sideBar`, `menu`, `input`, `tab.active`) adjusts the **foreground**.
- The activity bar targets 3:1 (icon contrast); the rest target 4.5:1.
- Translucent or non-hex colours are returned unchanged: their real backdrop is unknown, and
  rewriting them would change the design instead of repairing it.
- Black or white text is the last resort when the chosen direction runs out of lightness.

`editor.*` is deliberately untouched: Monaco renders the raw theme, so repairing it here would
desynchronise the editor from the workbench chrome. The derived `activityBar.inactiveForeground`
now uses the **repaired** active colour, so Min Light's inactive icons are no longer white on a
light bar.

### File and product icons

`src/renderer/src/theme/fileIconTheme.ts`, `productIconTheme.ts`, `ui/Icon.tsx`

- Resolution is memoised in a `WeakMap` keyed by the theme object, so scrolling a large tree does
  not rebuild URLs, glyphs and font families for every row. The map is dropped with the theme.
- `assetUrl()` accepts only `stratum-asset:`. A theme cannot point an `<img>` or `@font-face` at
  `file:`, `http:` or a malformed URL; the icon falls back instead.
- `cssUrl()` percent-escapes quotes, backslashes and newlines, and font ids/weights/styles are
  reduced to `[\w-]`, so a crafted theme path or font id cannot close the declaration.
- `decodeFontCharacter()` implements the CSS escape syntax (`\e001`, `\ea60`, `\1f600`, optional
  trailing space). The previous `JSON.parse('"\e001"')` is not valid JSON and threw inside render.
- Product icon CSS rejects a dangling odd backslash in `content:"…"`, which would otherwise escape
  the closing quote and swallow the rest of the stylesheet.

## Updates

`src/core/update.ts`, `src/main/services/updateService.ts`, update popover and Settings

Valet Deck's updater is explicit (`autoDownload=false`, `autoInstallOnAppQuit=false`) and maps
errors to friendly text; its updater cache still held the **already installed** 0.1.1 `.deb` and
`update-info.json`, which is the failure mode Stratum now avoids.

- `describeUpdateError()` classifies network, missing feed metadata, permission, integrity and
  unknown failures into a sentence with a next step. Technical detail stays in the main log.
- `afterUpdateFailure()` preserves a known `available` version and a downloaded `ready` build; a
  failed **download** falls back to `available` so it can be retried. An offline background check
  must not hide the installer or the offered version.
- A check that resolves without emitting an event now settles on `up-to-date` instead of leaving
  the panel checking forever.
- On `update-not-available`, the updater's `pending` folder is removed (packaged builds only, never
  while downloading or ready). `updaterCacheDirName` is parsed from `app-update.yml` — a plain name
  only, no separators or traversal — and the cache root mirrors electron-updater per platform.
- The desktop notification is sent once per downloaded version per run.
- The popover and Settings show `error` while a known update remains available, instead of looking
  as if nothing failed.

Stratum keeps its existing behaviour: automatic checks 20 s after launch and every four hours,
background download controlled by `update.autoDownload`, explicit install, and no self-update on
portable, Snap or development builds.

## Verification

```bash
npx vitest run tests/theme.test.ts tests/fileIcons.test.ts tests/themeService.test.ts tests/update.test.ts
npm run verify
npm run smoke   # Xvfb; on a desktop session run Electron directly with STRATUM_SMOKE
```

Phase 13 results: 74 focused tests, **667 passed / 45 skipped** in the full suite,
dependency-cruiser clean (184 modules, 606 dependencies), production build successful, and the
16-step Electron smoke finished with **0 console errors and 0 crashes**.
