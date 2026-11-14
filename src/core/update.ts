/** Pure helpers for the update UI. No Electron, no network: easy to test and safe to share. */
import type { UpdatePackageKind, UpdatePhase, UpdateProgress, UpdateState } from '../shared/update'

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
