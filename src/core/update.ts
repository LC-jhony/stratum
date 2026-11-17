/** Pure helpers for the update UI. No Electron, no network: easy to test and safe to share. */
import type { UpdatePackageKind, UpdatePhase, UpdateProgress, UpdateState } from '../shared/update'

const NETWORK = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|net::ERR_|socket hang up|timed?\s*out/i
const FEED = /(?:^|\D)404(?:\D|$)|latest-(?:linux|mac|win)|Cannot find|Unable to find|no published versions/i
const PERMISSION = /EACCES|EPERM|permission denied|operation not permitted/i
const CHECKSUM = /sha512|checksum|signature (?:mismatch|verification)/i

/**
 * Turns an electron-updater failure into a sentence a person can act on. Technical details stay
 * in the main-process log; the panel shows the diagnosis and the next step instead of a stack.
 */
export function describeUpdateError(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error ?? ''))
    .replace(/^Error:\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!raw) return 'The update failed for an unknown reason.'
  if (CHECKSUM.test(raw)) return 'The download failed its integrity check and was discarded. Try again.'
  if (NETWORK.test(raw)) return 'No network connection: the update could not be checked. Try again when you are online.'
  if (FEED.test(raw)) return 'The release does not include the update metadata for this platform, so the update cannot be verified. Download it from GitHub Releases.'
  if (PERMISSION.test(raw)) return 'The downloaded update cannot be installed with the current permissions.'
  return raw.slice(0, 500)
}

/**
 * State after a failed check or download. A version that was already known stays known: an
 * offline background check must not hide the downloaded installer or the offered version.
 */
export function afterUpdateFailure(state: UpdateState, message: string, at = new Date().toISOString()): UpdateState {
  // A failed download still knows which version was offered, so the panel can offer it again.
  const keep = state.phase === 'available' || state.phase === 'downloading' || state.phase === 'ready'
  return {
    ...state,
    phase: keep ? (state.phase === 'downloading' ? 'available' : state.phase) : 'error',
    error: message,
    checkedAt: at,
  }
}

/**
 * Reads `updaterCacheDirName` from an app-update.yml without pulling a YAML parser into core.
 * Only a plain directory name is accepted; anything with separators or traversal is ignored.
 */
export function updaterCacheDirName(config: string): string | undefined {
  const match = config.match(/^\s*updaterCacheDirName:\s*([^\s#]+)\s*(?:#.*)?$/m)
  if (!match) return undefined
  const name = match[1].replace(/^["']|["']$/g, '')
  return /^[\w.-]+$/.test(name) && name !== '.' && name !== '..' ? name : undefined
}

const PACKAGE_LABELS: Record<UpdatePackageKind, string> = {
  appimage: 'AppImage',
  deb: 'Debian package',
  rpm: 'RPM package',
  pacman: 'Arch package',
  nsis: 'Windows installer',
  portable: 'Portable build',
  mac: 'macOS build',
  snap: 'Snap package',
  unknown: 'Packaged build',
  dev: 'Development build',
}

export const packageKindLabel = (kind: UpdatePackageKind | undefined): string => PACKAGE_LABELS[kind ?? 'unknown']

export const updatePhaseLabel = (state: UpdateState | undefined): string => {
  if (!state) return 'Loading…'
  switch (state.phase) {
    case 'idle': return 'Ready to check'
    case 'checking': return 'Checking for updates…'
    case 'available': return state.version ? `Version ${state.version} is available` : 'An update is available'
    case 'downloading': return `Downloading ${Math.round(state.progress?.percent ?? 0)}%`
    case 'ready': return state.version ? `Version ${state.version} is ready to install` : 'Update ready to install'
    case 'up-to-date': return 'You are on the latest version'
    case 'error': return state.error ?? 'The update check failed'
    case 'disabled': return state.error ?? 'Automatic updates are unavailable for this build'
  }
}

/** Progress is undefined when the updater cannot report sizes (some proxies and local feeds). */
export const updateProgress = (state: UpdateState | undefined): UpdateProgress | undefined => {
  const p = state?.progress
  if (!p) return undefined
  return {
    percent: Math.max(0, Math.min(100, p.percent || 0)),
    transferred: Math.max(0, p.transferred || 0),
    total: Math.max(0, p.total || 0),
    bytesPerSecond: Math.max(0, p.bytesPerSecond || 0),
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'kB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** i
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

export const formatSpeed = (bytesPerSecond: number): string => `${formatBytes(bytesPerSecond)}/s`

/**
 * electron-updater returns notes as a string or as a list of per-version notes. Flatten both and
 * strip control characters so the UI can render them as plain text (never as HTML).
 */
export function normalizeReleaseNotes(notes: UpdateState['releaseNotes'] | Array<{ version?: string; note?: string | null }> | null): string | undefined {
  const text = Array.isArray(notes)
    ? notes.map((entry) => {
        const note = (entry.note ?? '').trim()
        if (!note) return ''
        return `${entry.version ? `Version ${entry.version}\n` : ''}${note}`
      }).filter(Boolean).join('\n\n')
    : notes ?? ''
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
  return clean ? clean.slice(0, 20_000) : undefined
}

/** Stable status-bar label; the panel and Settings use the longer `updatePhaseLabel`. */
export function statusLabel(state: UpdateState | undefined): string {
  if (!state) return ''
  switch (state.phase) {
    case 'checking': return 'Checking…'
    case 'available': return state.version ? `Update ${state.version}` : 'Update available'
    case 'downloading': return `${Math.round(updateProgress(state)?.percent ?? 0)}%`
    case 'ready': return 'Restart to update'
    case 'up-to-date': return 'Up to date'
    case 'error': return 'Update failed'
    default: return ''
  }
}

export const isUpdatePhase = (state: UpdateState | undefined, ...phases: UpdatePhase[]): boolean => !!state && phases.includes(state.phase)
