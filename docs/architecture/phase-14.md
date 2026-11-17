# Phase 14 — Appearance selection: palette families and file icon themes

Settings ▸ Appearance now follows the requested model:

| Control | Options | What it applies |
|---|---|---|
| Theme | System, Light, Dark | The colour mode. System follows the OS live. |
| Palette | Carbon, Min | The chosen palette's **Dark** or **Light** variant, according to the mode. |
| File icons | Dawn, Deep, Dim, You | The chosen icon theme's dark or light asset set, according to the active palette. |

The old free-form "Color theme" dropdown and the "None" file-icon button are gone from Settings.
The full catalog, including imported VS Code themes, is still available from the command palette
(**Preferences: Color Theme**, `Ctrl+K Ctrl+T`), the **View** menu and the status-bar theme button.
When a custom theme is active, Settings says so and leaves Carbon/Min unselected instead of
silently replacing it.

## How a family resolves to a variant

`src/renderer/src/theme/themeManager.ts`

- `paletteOf(entry)` maps a colour theme to `carbon` or `min`. It matches the built-in labels
  (`Carbon Dark`, `Carbon Light`, `Min Dark`, `Min Light`) and falls back to the built-in id. Label
  matching matters because `dedupeCatalog` may keep a user override with the same label; the user's
  file must still count as that palette.
- `paletteTheme(family, mode, osDark, catalog)` resolves the family and the mode through
  `kindForMode` (`System` asks the OS) and returns the matching variant. Selecting **Min** while the
  theme is **Light** applies `Min Light`; switching the theme to **Dark** then swaps to `Min Dark`
  through the existing sibling logic.
- `fileIconFamily(entry)` recognises `Dawn`, `Deep`, `Dim` and `You`; imported icon themes return
  `undefined`, so they never light up a built-in chip. `fileIconTheme(family, catalog)` returns the
  entry, preferring a deduped user override when one exists.
- `kindForMode` is now shared by `pickThemeEntry`, `applyMode` and the palette picker, so the three
  paths cannot disagree about what System means.

The persisted settings keep the concrete variant in `colorTheme` (`builtin:min-light.json`) and the
mode in `appearance.mode`; nothing new is stored. `fileIconTheme` keeps the family entry id
(`builtin:dawn.json`). On restart `ThemeManager.init` resolves the stored variant against the mode
and swaps to its sibling when needed, so the palette survives an OS switch in System mode.

## File icons follow light and dark

The four bundled file icon themes already carry a `light` association block and `__<id>` icon
definitions pointing at their `<theme>-light/` folders. `Icon` chooses the set from the workbench's
`data-theme`, which `applyColorTheme` writes from the applied colour theme. Selecting a palette
therefore changes the tree and tab icons without a second setting: Dawn Dark with Carbon Dark,
Dawn Light with Carbon Light. Settings previews both flavours and shows the one that matches the
current palette.

## Defaults and restore

- A first run starts in dark mode (existing behaviour) with **Carbon** and **Dawn**.
- `DEFAULT_SETTINGS.fileIconTheme` is `builtin:dawn.json`; an explicit `null` (still reachable from
  the command palette's *None*) is preserved and wins over the default.
- **Restore defaults** selects Carbon + Dawn again instead of clearing the icon theme.
- **Cancel** still restores the theme, mode and icon theme captured when the dialog opened. The
  new palette and icon buttons preview live, so a cancelled dialog leaves no trace.

## Files

- `src/renderer/src/theme/themeManager.ts` — palette/icon family helpers and shared `kindForMode`.
- `src/renderer/src/features/settings/SettingsDialog.tsx` — Palette and File icons controls, live
  light/dark previews, cancel/restore handling.
- `src/core/settings.ts` — Dawn as the default file icon theme.
- `tests/theme.test.ts`, `tests/settings.test.ts` — family mapping, mode resolution, dedupe override,
  default icon theme and explicit None.
- `scripts/smoke.js` — the settings step now asserts both option lists and the selected values.

## Verification

```bash
npx vitest run tests/theme.test.ts tests/settings.test.ts
npm run verify
npm run smoke
```

Results:

- 58 focused tests in `theme.test.ts` and `settings.test.ts`.
- Full suite: **672 passed / 45 skipped** in 82 files.
- dependency-cruiser clean (184 modules, 604 dependencies); production build successful.
- Electron smoke: 16 steps, 0 console errors, 0 crashes. Its settings step reports
  `palette: [Carbon, Min]`, `fileIcons: [Dawn, Deep, Dim, You]`, `selectedPalette: Carbon`,
  `selectedFileIcons: Dawn`.
- A dedicated appearance smoke confirmed: Carbon + Light → Carbon Light; Min + Light → Min Light;
  Min + Dark → Min Dark; selecting You marks You; Cancel restores the opening theme.
