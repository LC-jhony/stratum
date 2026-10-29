#!/usr/bin/env node
/**
 * Prune the four Valet file-icon themes down to the ids Stratum uses.
 *
 * The upstream set is 952 SVGs per flavour (~38 MB per theme pair). Stratum only needs the
 * database objects the explorer and the tabs draw, so this script copies those SVGs and trims
 * every definition/association map to the kept ids. Output is committed: `npm run build` and CI
 * never need the Valet checkout.
 *
 * Usage:
 *   node scripts/sync-file-icons.mjs [source-dir]
 *   STRATUM_ICON_SOURCE=../valet-dashboard/src/renderer/file-icons node scripts/sync-file-icons.mjs
 *
 * `source-dir` defaults to `../valet-dashboard/src/renderer/file-icons` (sibling checkout).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const THEMES = [
  { file: 'dawn', name: 'Dawn' },
  { file: 'deep', name: 'Deep' },
  { file: 'dim', name: 'Dim' },
  { file: 'you', name: 'You' },
]

/** Objects and file kinds the workbench asks for by id. Folder defaults are added per theme. */
const BASE_IDS = [
  'database', // data source
  'table', // table
  'folder_database', 'folder_database_open', // schema (collapsed / expanded)
  'folder_schema', 'folder_schema_open', // schema alias some themes prefer
  'folder_views', 'folder_views_open', // view
  'csv', 'json', 'markdown', 'settings',
]

const DEFAULTS = ['file', 'folder', 'folderExpanded', 'rootFolder', 'rootFolderExpanded']
const OPTIONAL_MAPS = ['fileExtensions', 'fileNames', 'folderNames', 'folderNamesExpanded', 'languageIds']

const source = path.resolve(process.argv[2] ?? process.env.STRATUM_ICON_SOURCE ?? '../valet-dashboard/src/renderer/file-icons')
const out = path.resolve('themes')

if (!existsSync(path.join(source, 'dawn.json'))) {
  console.error(`sync-file-icons: no dawn.json in ${source}`)
  console.error('  Pass the valet file-icons directory as an argument or set STRATUM_ICON_SOURCE.')
  process.exit(1)
}

/** Values in the light/high-contrast maps point at the `__id` twin; keep the id when its base is kept. */
const baseId = (id) => (id.startsWith('__') ? id.slice(2) : id)

function pruneMap(map, keep) {
  if (!map) return undefined
  const entries = Object.entries(map).filter(([, id]) => keep.has(baseId(id)))
  return entries.length ? Object.fromEntries(entries) : undefined
}

/** Copy the SVGs a definition points at, keeping the theme's relative layout (`./dawn/table.svg`). */
function copyIcon(themeFile, definition, copied) {
  if (!definition?.iconPath) return
  const rel = definition.iconPath.replace(/^\.\//, '')
  if (copied.has(rel)) return
  const from = path.join(source, rel)
  if (!existsSync(from)) throw new Error(`sync-file-icons: ${themeFile} references missing ${rel}`)
  cpSync(from, path.join(out, rel))
  copied.add(rel)
}

for (const theme of THEMES) {
  const themeFile = `${theme.file}.json`
  const json = JSON.parse(readFileSync(path.join(source, themeFile), 'utf8'))
  const keep = new Set(BASE_IDS)
  for (const key of DEFAULTS) if (json[key]) keep.add(json[key])

  // Only keep definitions whose id is used, plus their `__id` light twin.
  const iconDefinitions = {}
  for (const id of [...keep]) {
    for (const key of [id, `__${id}`]) if (json.iconDefinitions?.[key]) iconDefinitions[key] = json.iconDefinitions[key]
  }

  const pruned = {
    name: theme.name,
    file: json.file,
    folder: json.folder,
    folderExpanded: json.folderExpanded,
    rootFolder: json.rootFolder,
    rootFolderExpanded: json.rootFolderExpanded,
    iconDefinitions,
  }
  const maps = {}
  for (const key of OPTIONAL_MAPS) {
    const map = pruneMap(json[key], keep)
    if (map) maps[key] = map
  }
  Object.assign(pruned, maps)
  // Same maps again in light flavour; the theme engine reads `light` first when the mode is light.
  const light = {}
  for (const key of OPTIONAL_MAPS) {
    const map = pruneMap(json.light?.[key], keep)
    if (map) light[key] = map
  }
  if (Object.keys(light).length) pruned.light = light

  // Replace the generated flavour directories so stale icons cannot linger between runs.
  for (const dir of [theme.file, `${theme.file}-light`]) rmSync(path.join(out, dir), { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const copied = new Set()
  for (const definition of Object.values(iconDefinitions)) copyIcon(themeFile, definition, copied)
  writeFileSync(path.join(out, themeFile), `${JSON.stringify(pruned, null, 2)}\n`)

  const bytes = [...copied].reduce((sum, rel) => sum + readFileSync(path.join(out, rel)).length, 0)
  console.log(`${themeFile}: ${Object.keys(iconDefinitions).length} definitions, ${copied.size} SVGs, ${(bytes / 1024).toFixed(1)} kB`)
}
