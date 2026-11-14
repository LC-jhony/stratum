import { app, Notification, shell, type BrowserWindow } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { normalizeReleaseNotes } from '../../core/update'
import type { UpdateOrigin, UpdatePackageKind, UpdateProgress, UpdateState } from '../../shared/update'
import type { SettingsService } from './settingsService'

const RELEASES_URL = 'https://github.com/LC-jhony/stratum/releases'
const FIRST_CHECK_DELAY_MS = 20_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const PROGRESS_THROTTLE_MS = 150

/** How this copy was installed. Mirrors electron-updater's own Linux `package-type` detection. */
export function detectPackageKind(): UpdatePackageKind {
  if (!app.isPackaged) return 'dev'
  if (process.platform === 'linux') {
    if (process.env.APPIMAGE) return 'appimage'
    if (process.env.SNAP) return 'snap'
    try {
      const kind = readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim()
      if (kind === 'deb' || kind === 'rpm' || kind === 'pacman') return kind
    } catch { /* not a deb/rpm/pacman install */ }
    return 'unknown'
  }
  if (process.platform === 'win32') return process.env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'nsis'
  if (process.platform === 'darwin') return 'mac'
  return 'unknown'
}

const AUTO_INSTALL: ReadonlySet<UpdatePackageKind> = new Set(['appimage', 'deb', 'rpm', 'pacman', 'nsis', 'mac'])

const disabledReason = (kind: UpdatePackageKind): string => {
  switch (kind) {
    case 'dev': return 'Updates are available in packaged builds. This is a development build.'
    case 'portable': return 'Portable builds update manually. Download the latest installer from GitHub Releases.'
    case 'snap': return 'Snap packages are updated by the Snap Store.'
    default: return 'This build has no update feed. Download the latest package from GitHub Releases.'
  }
}

const friendlyError = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error:\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 500) || 'The update failed for an unknown reason.'
}

const progressOf = (info: ProgressInfo): UpdateProgress => ({
  percent: Number.isFinite(info.percent) ? info.percent : 0,
  transferred: info.transferred || 0,
  total: info.total || 0,
  bytesPerSecond: info.bytesPerSecond || 0,
})

/**
 * Main-process update coordinator.
 *
 * electron-updater handles the protocol details (GitHub provider, signatures, differential
 * downloads) for AppImage, deb, rpm, NSIS and macOS builds. This service owns the state machine,
 * the quiet background schedule and the renderer notifications, and keeps manual checks explicit
 * so a broken network never turns into a dialog on startup.
 */
export class UpdateService {
  private state: UpdateState
  private origin: UpdateOrigin = 'auto'
  private checking?: Promise<UpdateState>
  private downloadingPromise?: Promise<UpdateState>
  private lastProgressAt = 0
  private firstTimer?: ReturnType<typeof setTimeout>
  private intervalTimer?: ReturnType<typeof setInterval>
  private readonly disabled: string | undefined
  /** True once the user asked to install; the window then exits without the graceful quit delay. */
  private quittingForUpdate = false

  constructor(private readonly deps: { getWindow: () => BrowserWindow | null; settings: SettingsService }) {
    const packageKind = detectPackageKind()
    this.disabled = AUTO_INSTALL.has(packageKind) ? undefined : disabledReason(packageKind)
    this.state = {
      phase: this.disabled ? 'disabled' : 'idle',
      currentVersion: app.getVersion(),
      packageKind,
      canAutoInstall: AUTO_INSTALL.has(packageKind),
      origin: 'auto',
      ...(this.disabled ? { error: this.disabled } : {}),
    }
    this.configure()
  }

  private configure() {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.allowDowngrade = false
    autoUpdater.logger = {
      info: (message?: unknown) => console.info('[updates]', message),
      warn: (message?: unknown) => console.warn('[updates]', message),
      error: (message?: unknown) => console.error('[updates]', message),
      debug: (message: string) => console.debug('[updates]', message),
    }
    autoUpdater.on('checking-for-update', () => this.set({ phase: 'checking' }))
    autoUpdater.on('update-available', (info) => this.available(info))
    autoUpdater.on('update-not-available', () => this.set({
      phase: 'up-to-date',
      version: undefined,
      releaseName: undefined,
      releaseNotes: undefined,
      releaseDate: undefined,
      progress: undefined,
      checkedAt: new Date().toISOString(),
      error: undefined,
    }))
    autoUpdater.on('download-progress', (info) => this.progress(info))
    autoUpdater.on('update-downloaded', (info) => {
      this.set({
        phase: 'ready',
        version: info.version,
        releaseName: info.releaseName ?? undefined,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        releaseDate: info.releaseDate,
        progress: { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 },
        checkedAt: new Date().toISOString(),
        error: undefined,
      })
      this.notifyReady()
    })
    autoUpdater.on('error', (error) => this.fail(error))
  }

  /** Start the quiet background schedule. Manual checks remain available even when this is off. */
  start() {
    if (this.disabled || process.env.STRATUM_SMOKE) return
    this.stop()
    this.firstTimer = setTimeout(() => { void this.autoCheck() }, FIRST_CHECK_DELAY_MS)
    this.intervalTimer = setInterval(() => { void this.autoCheck() }, CHECK_INTERVAL_MS)
    this.firstTimer.unref?.()
    this.intervalTimer.unref?.()
  }

  stop() {
    if (this.firstTimer) clearTimeout(this.firstTimer)
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    this.firstTimer = undefined
    this.intervalTimer = undefined
  }

  getState(): UpdateState { return structuredClone(this.state) }

  private async autoCheck() {
    if (this.disabled || process.env.STRATUM_SMOKE) return
    try {
      const settings = await this.deps.settings.get()
      if (settings['update.autoCheck'] === false) return
    } catch { return }
    await this.check('auto')
  }

  /** Check the feed. Returns the state after the feed answers (or after a failure). */
  async check(origin: UpdateOrigin = 'manual'): Promise<UpdateState> {
    if (this.disabled) {
      this.set({ phase: 'disabled', origin, error: this.disabled, checkedAt: new Date().toISOString() })
      return this.getState()
    }
    if (this.checking) return this.checking
    if (this.state.phase === 'downloading' || this.state.phase === 'ready') return this.getState()
    this.origin = origin
    this.set({ phase: 'checking', origin, error: undefined })
    this.checking = autoUpdater.checkForUpdates()
      .then(() => this.getState())
      .catch((error) => this.fail(error, origin))
      .finally(() => { this.checking = undefined })
    return this.checking
  }

  /** Download the available update. Called by the user or by the auto-download preference. */
  async download(origin: UpdateOrigin = 'manual'): Promise<UpdateState> {
    if (this.disabled || this.state.phase !== 'available') return this.getState()
    if (this.downloadingPromise) return this.downloadingPromise
    this.origin = origin
    this.set({
      phase: 'downloading',
      origin,
      error: undefined,
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
    })
    this.downloadingPromise = autoUpdater.downloadUpdate()
      .then(() => this.getState())
      .catch((error) => this.fail(error, origin))
      .finally(() => { this.downloadingPromise = undefined })
    return this.downloadingPromise
  }

  /** Restart into the downloaded version. electron-updater closes the app and launches the new build. */
  install(): boolean {
    if (this.state.phase !== 'ready') return false
    this.quittingForUpdate = true
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
    return true
  }

  /**
   * The AppImage updater spawns the new build before quitting. The window must not keep the
   * process alive for the usual graceful cleanup: the new build would fail the single-instance
   * check and exit. main/index.ts consults this in `before-quit`.
   */
  isQuittingForUpdate(): boolean { return this.quittingForUpdate }

  openReleasePage(): void {
    const version = this.state.version
    void shell.openExternal(version ? `${RELEASES_URL}/tag/v${version}` : `${RELEASES_URL}/latest`)
  }

  private available(info: UpdateInfo) {
    this.set({
      phase: 'available',
      version: info.version,
      releaseName: info.releaseName ?? undefined,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      releaseDate: info.releaseDate,
      progress: undefined,
      checkedAt: new Date().toISOString(),
      error: undefined,
    })
    void this.autoDownloadIfEnabled(this.origin)
  }

  private async autoDownloadIfEnabled(origin: UpdateOrigin) {
    try {
      const settings = await this.deps.settings.get()
      // Keep the origin of the check that found the update: a manual check must keep reporting.
      if (settings['update.autoDownload'] !== false && this.state.phase === 'available') await this.download(origin)
    } catch { /* a settings read failure must not break the update check */ }
  }

  private progress(info: ProgressInfo) {
    const now = Date.now()
    const percent = Number.isFinite(info.percent) ? info.percent : 0
    if (percent < 100 && now - this.lastProgressAt < PROGRESS_THROTTLE_MS) return
    this.lastProgressAt = now
    this.set({ phase: 'downloading', progress: progressOf(info), error: undefined })
  }

  private fail(error: unknown, origin: UpdateOrigin = this.origin): UpdateState {
    const message = friendlyError(error)
    this.set({ phase: 'error', origin, error: message, checkedAt: new Date().toISOString() })
    return this.getState()
  }

  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch, origin: patch.origin ?? this.origin }
    const win = this.deps.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('update:state', this.getState())
  }

  private notifyReady() {
    if (process.env.STRATUM_SMOKE) return
    try {
      if (!Notification.isSupported()) return
      const win = this.deps.getWindow()
      if (win?.isFocused()) return
      const notification = new Notification({
        title: 'Stratum update ready',
        body: this.state.version ? `Version ${this.state.version} is downloaded. Restart to install it.` : 'The update is downloaded. Restart to install it.',
      })
      notification.on('click', () => {
        const current = this.deps.getWindow()
        if (!current || current.isDestroyed()) return
        current.show()
        current.focus()
        current.webContents.send('command', 'update.open')
      })
      notification.show()
    } catch { /* notifications are optional; the status bar still shows the update */ }
  }
}
