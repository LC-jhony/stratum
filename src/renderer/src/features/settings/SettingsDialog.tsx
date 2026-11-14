import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ipc } from '../../ipc/client'
import { DEFAULT_SETTINGS, mergeSettings, type AppearanceMode, type KeywordCase, type SideBarPosition, type StratumSettings, type UiFont } from '../../../../core/settings'
import type { ThemeManifestEntry } from '../../../../shared/types'
import { useWorkbench } from '../../store/workbench'
import { themes } from '../../theme/themeManager'
import { themeKind, type ColorThemeJson } from '../../theme/colorTheme'
import { resolveFileIconById, type FileIconThemeJson } from '../../theme/fileIconTheme'
import { clampUiFontSize, MAX_UI_FONT_SIZE, MIN_UI_FONT_SIZE } from '../../theme/appearance'
import { MONO_FONTS, systemFonts } from '../../theme/fonts'
import { formatBytes, formatSpeed, packageKindLabel, updatePhaseLabel, updateProgress } from '../../../../core/update'
import { Icon } from '../../ui/Icon'

const KEYWORD_CASES: { id: KeywordCase; label: string }[] = [
  { id: 'upper', label: 'UPPERCASE (SELECT)' },
  { id: 'lower', label: 'lowercase (select)' },
  { id: 'preserve', label: 'keep as typed' },
]

const MODES: { id: AppearanceMode; label: string; hint: string }[] = [
  { id: 'light', label: 'Light', hint: 'Always use a light theme' },
  { id: 'dark', label: 'Dark', hint: 'Always use a dark theme' },
  { id: 'system', label: 'System', hint: 'Follow the OS color scheme' },
]

const UI_FONTS: { id: UiFont; label: string; hint: string }[] = [
  { id: 'system', label: 'System', hint: 'The platform interface font' },
  { id: 'mono', label: 'Monospace', hint: 'A monospaced interface' },
  { id: 'serif', label: 'Serif', hint: 'A serif interface' },
  { id: 'custom', label: 'Other', hint: 'An installed font family' },
]

const SIDES: { id: SideBarPosition; label: string; hint: string }[] = [
  { id: 'left', label: 'Left', hint: 'Activity bar and side bar on the left' },
  { id: 'right', label: 'Right', hint: 'Activity bar and side bar on the right' },
]

/** Keys owned by the theme manager (written straight to settings.json); a stale dialog draft must not overwrite them. */
const MANAGED_KEYS = ['colorTheme', 'fileIconTheme', 'productIconTheme', 'colorScheme', 'windowBackground', 'titleBarBackground', 'titleBarForeground']

/** Appearance values that preview live, restored from a snapshot if the dialog is cancelled. */
const APPEARANCE_KEYS = ['appearance.mode', 'appearance.uiFont', 'appearance.customFont', 'appearance.fontSize', 'appearance.compact', 'workbench.sideBar.position'] as const

const appearanceOf = (s: StratumSettings): Partial<StratumSettings> =>
  Object.fromEntries(APPEARANCE_KEYS.map((k) => [k, s[k]]))

/** Application settings: editor, SQL completion (DataGrip-style), query safety, JDBC sidecar and raw JSON. */
export function SettingsDialog() {
  const { prefs, savePrefs, previewPrefs, closeSettings } = useWorkbench()
  const update = useWorkbench((s) => s.update)
  const checkUpdates = useWorkbench((s) => s.checkUpdates)
  const downloadUpdate = useWorkbench((s) => s.downloadUpdate)
  const installUpdate = useWorkbench((s) => s.installUpdate)
  const updateMeter = updateProgress(update)
  const active = useSyncExternalStore(themes.subscribe.bind(themes), () => themes.active)
  const [draft, setDraft] = useState<StratumSettings>(() => mergeSettings({ ...prefs, 'appearance.mode': themes.mode }))
  const [rawMode, setRawMode] = useState(false)
  const [json, setJson] = useState(() => JSON.stringify(mergeSettings(prefs), null, 2))
  const [err, setErr] = useState<string>()
  const [fonts, setFonts] = useState<string[]>(MONO_FONTS)
  const [iconPreview, setIconPreview] = useState<Record<string, string>>({})
  const mode0 = useRef<AppearanceMode>(themes.mode)
  const theme0 = useRef(themes.active.color?.entry)
  const fileIcon0 = useRef(themes.active.fileIcon?.entry)
  const appearance0 = useRef(appearanceOf(prefs))
  useEffect(() => { let live = true; void systemFonts().then((sys) => { if (live && sys.length) setFonts([...MONO_FONTS, ...sys.filter((f) => !MONO_FONTS.includes(f))]) }); return () => { live = false } }, [])
  // One representative icon per installed file-icon theme, so the picker previews what it applies.
  useEffect(() => {
    let live = true
    void (async () => {
      const out: Record<string, string> = {}
      for (const entry of themes.catalog.filter((e) => e.kind === 'fileIcon')) {
        try {
          const file = await ipc.themes.read(entry.path)
          const icon = resolveFileIconById(file.json as FileIconThemeJson, file.baseUrl, 'folder_database')
          if (icon?.kind === 'image') out[entry.id] = icon.url
        } catch { /* unreadable theme: keep the picker text-only */ }
      }
      if (live) setIconPreview(out)
    })()
    return () => { live = false }
  }, [])
  const up = (p: Partial<StratumSettings>) => { setDraft((d) => ({ ...d, ...p })); setErr(undefined) }
  /** Appearance previews through the store, so the workbench behind the dialog repaints live. */
  const previewAppearance = (p: Partial<StratumSettings>) => { up(p); previewPrefs(p) }
  /** Color mode previews instantly (the workbench re-themes behind the dialog); Cancel restores the mode on open. */
  const pickMode = (id: AppearanceMode) => { up({ 'appearance.mode': id }); void themes.applyMode(id) }
  /** Color theme picker: previews in memory only (like the mode); OK persists whatever theme ends up active. */
  const pickTheme = async (id: string) => {
    const entry = themes.catalog.find((e) => e.kind === 'color' && e.id === id)
    if (!entry) return
    await themes.set(entry, false)
    const picked = themes.active.color?.json as ColorThemeJson | undefined
    if (picked) up({ 'appearance.mode': themeKind(picked) }) // Picking a theme pins its kind, exactly like the palette.
  }
  /** File icon themes repaint the tree and tabs while the dialog is open; Cancel restores the previous one. */
  const pickFileIcons = async (id: string | null) => {
    if (!id) return themes.clear('fileIcon')
    const entry = themes.catalog.find((e) => e.kind === 'fileIcon' && e.id === id)
    if (entry) await themes.set(entry, false)
  }
  /** Side bar position previews instantly too (store only, no disk write); Cancel restores the side on open. */
  const pickSide = (id: SideBarPosition) => { up({ 'workbench.sideBar.position': id }); previewPrefs({ 'workbench.sideBar.position': id }) }
  const cancel = () => {
    const t0 = theme0.current, fi0 = fileIcon0.current
    previewPrefs(appearance0.current)
    closeSettings()
    void (async () => { // Restore the theme first so the mode restore can keep it (their kinds agree by construction).
      if (fi0 && themes.active.fileIcon?.entry.id !== fi0.id) await themes.set(fi0, false)
      else if (!fi0 && themes.active.fileIcon) await themes.clear('fileIcon')
      if (t0 && themes.active.color?.entry.id !== t0.id) await themes.set(t0, false)
      if (themes.mode !== mode0.current) await themes.applyMode(mode0.current)
    })()
  }
  const toggleRaw = () => { if (!rawMode) setJson(JSON.stringify(draft, null, 2)); else { try { setDraft(mergeSettings(JSON.parse(json) as Record<string, unknown>)); setErr(undefined) } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return } } setRawMode(!rawMode) }
  const restore = () => {
    setDraft(DEFAULT_SETTINGS); setJson(JSON.stringify(DEFAULT_SETTINGS, null, 2))
    previewPrefs(appearanceOf(DEFAULT_SETTINGS))
    void themes.applyMode(DEFAULT_SETTINGS['appearance.mode'])
    void themes.clear('fileIcon')
  }
  const apply = async () => {
    let parsed: Record<string, unknown>
    if (rawMode) {
      try { parsed = JSON.parse(json) as Record<string, unknown> } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return }
    } else parsed = draft as Record<string, unknown>
    const patch = Object.fromEntries(Object.entries(mergeSettings(parsed)).filter(([k]) => !MANAGED_KEYS.includes(k))) as Partial<StratumSettings>
    const colorId = themes.active.color?.entry.id
    if (colorId) patch.colorTheme = colorId // The theme that is actually active wins over the draft's stale copy.
    patch.fileIconTheme = themes.active.fileIcon?.entry.id ?? null // Same for the icon theme chosen in the picker.
    await savePrefs(patch)
    void themes.applyMode(patch['appearance.mode'] as AppearanceMode) // The saved mode wins even when the store value did not change.
    closeSettings()
  }
  const pickJar = async () => { const f = await ipc.dialogs.pickFile([{ name: 'Java archive', extensions: ['jar'] }]); if (f) up({ 'jdbc.jarPath': f }) }
  const colorThemes = themes.catalog.filter((e) => e.kind === 'color')
  const fileIconThemes = themes.catalog.filter((e) => e.kind === 'fileIcon')
  const themeGroups: { label: string; items: ThemeManifestEntry[] }[] = [
    { label: 'Built-in', items: colorThemes.filter((e) => e.source === 'builtin') },
    { label: 'User themes', items: colorThemes.filter((e) => e.source === 'user') },
    { label: 'Extensions', items: colorThemes.filter((e) => e.source === 'vscode-extension') },
  ].filter((g) => g.items.length > 0)
  const F = ({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) => <label className={`field ${wide ? 'span-2' : ''}`}><span>{label}</span>{children}</label>
  const Check = ({ label, k }: { label: string; k: keyof StratumSettings }) => <label className="check span-2"><input type="checkbox" checked={!!draft[k]} onChange={(e) => up({ [k]: e.target.checked } as Partial<StratumSettings>)} /> {label}</label>

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div className="dialog" role="dialog" aria-label="Settings">
        <header><Icon id="settings-gear" /> Settings<button onClick={cancel}><Icon id="close" /></button></header>
        <div className="form settings-form">
          <h3 className="section">Appearance</h3>
          <div className="field span-2"><span>Theme</span>
            <div className="seg" role="radiogroup" aria-label="Theme">{MODES.map((m) => <button key={m.id} type="button" role="radio" aria-checked={draft['appearance.mode'] === m.id} title={m.hint} className={draft['appearance.mode'] === m.id ? 'toggled' : ''} onClick={() => pickMode(m.id)}>{m.label}</button>)}</div>
          </div>
          <F label="Color theme" wide>
            <select value={active.color?.entry.id ?? ''} onChange={(e) => void pickTheme(e.target.value)}>
              {themeGroups.map((g) => <optgroup key={g.label} label={g.label}>{g.items.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</optgroup>)}
            </select>
          </F>
          <div className="field span-2"><span>File icons</span>
            <div className="seg" role="radiogroup" aria-label="File icons">
              <button type="button" role="radio" aria-checked={!active.fileIcon} className={!active.fileIcon ? 'toggled' : ''} onClick={() => void pickFileIcons(null)}>None</button>
              {fileIconThemes.map((t) => (
                <button key={t.id} type="button" role="radio" aria-checked={active.fileIcon?.entry.id === t.id} title={t.label} className={active.fileIcon?.entry.id === t.id ? 'toggled' : ''} onClick={() => void pickFileIcons(t.id)}>
                  <span className="icon-opt">{iconPreview[t.id] && <img className="file-icon" src={iconPreview[t.id]} alt="" draggable={false} />}{t.label}</span>
                </button>
              ))}
            </div>
          </div>
          <p className="hint"><Icon id="file" /> Used by the database tree and the tab strip. Themes preview instantly; Cancel restores the one you opened with.</p>
          <div className="field span-2"><span>Font</span>
            <div className="seg" role="radiogroup" aria-label="Font">{UI_FONTS.map((f) => <button key={f.id} type="button" role="radio" aria-checked={draft['appearance.uiFont'] === f.id} title={f.hint} className={draft['appearance.uiFont'] === f.id ? 'toggled' : ''} onClick={() => previewAppearance({ 'appearance.uiFont': f.id })}>{f.label}</button>)}</div>
          </div>
          {draft['appearance.uiFont'] === 'custom' && <F label="Font family" wide><input placeholder="Name of an installed font, e.g. Fira Sans" value={draft['appearance.customFont']} onChange={(e) => previewAppearance({ 'appearance.customFont': e.target.value })} /></F>}
          <div className="field span-2"><span>Text size</span>
            <div className="ui-size-row"><input type="range" min={MIN_UI_FONT_SIZE} max={MAX_UI_FONT_SIZE} value={clampUiFontSize(draft['appearance.fontSize'])} aria-label="Text size" onChange={(e) => previewAppearance({ 'appearance.fontSize': Number(e.target.value) })} /><span className="ui-size-value">{clampUiFontSize(draft['appearance.fontSize'])}px</span></div>
          </div>
          <label className="check span-2"><input type="checkbox" checked={draft['appearance.compact']} onChange={(e) => previewAppearance({ 'appearance.compact': e.target.checked })} /> Compact view</label>
          <div className="field span-2"><span>Side bar position</span>
            <div className="seg" role="radiogroup" aria-label="Side bar position">{SIDES.map((s) => <button key={s.id} type="button" role="radio" aria-checked={draft['workbench.sideBar.position'] === s.id} title={s.hint} className={draft['workbench.sideBar.position'] === s.id ? 'toggled' : ''} onClick={() => pickSide(s.id)}>{s.label}</button>)}</div>
          </div>
          <p className="hint"><Icon id="symbol-field" /> Theme, File icons, Font, Text size and Compact preview live; Cancel restores the values you opened with.</p>
          <label className="check span-2"><input type="checkbox" checked={draft['workbench.sideBar.visible']} onChange={(e) => { up({ 'workbench.sideBar.visible': e.target.checked }); previewPrefs({ 'workbench.sideBar.visible': e.target.checked }) }} /> Show side bar</label>
          <Check label="Reopen SQL consoles after a restart" k="workbench.restoreTabs" />

          <h3 className="section">Editor</h3>
          <F label="Font family" wide><input list="stratum-mono-fonts" placeholder="Default (JetBrains Mono, SF Mono, …)" value={draft['editor.fontFamily']} onChange={(e) => up({ 'editor.fontFamily': e.target.value })} /><datalist id="stratum-mono-fonts">{fonts.map((f) => <option key={f} value={f} />)}</datalist></F>
          <F label="Font size"><input type="number" min={8} max={32} value={draft['editor.fontSize']} onChange={(e) => up({ 'editor.fontSize': Number(e.target.value) })} /></F>
          <F label="Tab size"><input type="number" min={1} max={8} value={draft['editor.tabSize']} onChange={(e) => up({ 'editor.tabSize': Number(e.target.value) })} /></F>
          <label className="check span-2"><input type="checkbox" checked={draft['editor.wordWrap'] === 'on'} onChange={(e) => up({ 'editor.wordWrap': e.target.checked ? 'on' : 'off' })} /> Word wrap</label>
          <Check label="Editor minimap" k="editor.minimap" />

          <h3 className="section">SQL completion</h3>
          <Check label="Enable context-aware completion" k="completion.enabled" />
          <Check label="Suggest on space (DataGrip style)" k="completion.suggestOnSpace" />
          <Check label="Automatically add aliases when completing table names" k="completion.autoAlias" />
          <Check label="Generate JOIN clauses from foreign keys" k="completion.joinByForeignKey" />
          <Check label="Live templates (sel, ins, upd, del, jo…)" k="completion.snippets" />
          <F label="Keyword case"><select value={draft['completion.keywordCase']} onChange={(e) => up({ 'completion.keywordCase': e.target.value as KeywordCase })}>{KEYWORD_CASES.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select></F>

          <h3 className="section">Query execution</h3>
          <F label="Rows per page"><input type="number" min={10} max={10000} value={draft['query.pageSize']} onChange={(e) => up({ 'query.pageSize': Number(e.target.value) })} /></F>
          <Check label="Confirm UPDATE / DELETE without WHERE" k="query.confirmDestructive" />
          <Check label="Prompt for SQL parameters (:name, :'name', ${name}, #name#)" k="query.parameters.enabled" />

          <h3 className="section">Data export</h3>
          <Check label="Protect CSV and other delimited exports from spreadsheet formulas" k="export.neutralizeFormulas" />
          <p className="hint"><Icon id="info" /> Text starting with =, +, - or @ is prefixed with an apostrophe so Excel and LibreOffice show it instead of executing it. Numbers and JSON/SQL exports are unaffected.</p>

          <h3 className="section">Updates</h3>
          <p className="hint"><Icon id="info" /> Current version {update?.currentVersion ?? '—'} · {packageKindLabel(update?.packageKind)}. Checks run shortly after launch and every four hours.</p>
          <Check label="Check for updates automatically" k="update.autoCheck" />
          <Check label="Download updates in the background" k="update.autoDownload" />
          <div className="field span-2"><span>Status</span>
            <div className="update-settings-row">
              <span className={`update-settings-text${update?.phase === 'error' ? ' error' : ''}`}>{updatePhaseLabel(update)}</span>
              {update?.phase !== 'downloading' && update?.phase !== 'checking' && update?.phase !== 'disabled' && <button type="button" onClick={() => void checkUpdates(false)}>Check now</button>}
              {update?.phase === 'available' && <button type="button" className="primary" onClick={() => void downloadUpdate()}>Download</button>}
              {update?.phase === 'ready' && <button type="button" className="primary" onClick={() => void installUpdate()}>Restart and install</button>}
              {update?.phase === 'disabled' && <button type="button" onClick={() => void ipc.update.openReleasePage()}>Open releases</button>}
            </div>
          </div>
          {updateMeter && update?.phase === 'downloading' && (
            <div className="span-2 update-settings-progress">
              <div className="update-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(updateMeter.percent)}><div className="update-fill" style={{ width: `${updateMeter.percent}%` }} /></div>
              <span className="update-meta">{Math.round(updateMeter.percent)}%{updateMeter.total > 0 && ` · ${formatBytes(updateMeter.transferred)} of ${formatBytes(updateMeter.total)}`}{updateMeter.bytesPerSecond > 0 && ` · ${formatSpeed(updateMeter.bytesPerSecond)}`}</span>
            </div>
          )}

          <h3 className="section">JDBC adapter (advanced)</h3>
          <F label="Server JAR" wide><div className="with-btn"><input value={draft['jdbc.jarPath']} placeholder="jdbc-adapter-server.jar (default: resources/, or STRATUM_JDBC_JAR)" onChange={(e) => up({ 'jdbc.jarPath': e.target.value })} /><button onClick={() => void pickJar()}>…</button></div></F>
          <F label="JAVA_HOME" wide><input value={draft['jdbc.javaHome']} placeholder="(default: java from PATH)" onChange={(e) => up({ 'jdbc.javaHome': e.target.value })} /></F>
          <p className="hint"><Icon id="info" /> The bundled adapter listens on 127.0.0.1:7823; JDBC changes restart the sidecar and apply from the next JDBC connection.</p>

          <h3 className="section">Advanced (JSON)</h3>
          <p className="hint"><Icon id="json" /> {rawMode ? 'Editing raw settings.json. Use “Apply raw JSON” to validate and keep editing, or OK to save.' : 'All settings are stored in settings.json and can be edited as JSON.'}</p>
          {rawMode && <textarea className="json" spellCheck={false} value={json} onChange={(e) => { setJson(e.target.value); setErr(undefined) }} />}
          <button className="span-2 raw-toggle" onClick={toggleRaw}>{rawMode ? 'Apply raw JSON' : 'Edit settings as JSON…'}</button>
          {err && <p className="hint error"><Icon id="error" /> {err}</p>}
        </div>
        <footer>
          <button onClick={restore}><Icon id="discard" /> Restore defaults</button>
          <span className="grow" />
          <button onClick={cancel}>Cancel</button>
          <button className="primary" onClick={() => void apply()}>OK</button>
        </footer>
      </div>
    </div>
  )
}
