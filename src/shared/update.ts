/**
 * Update contracts shared by the main process and the renderer.
 *
 * The renderer never talks to electron-updater: it receives a serialisable snapshot over IPC.
 * Keeping the shape here means both sides agree on the phases and on what the UI may show.
 */
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error' | 'disabled'

/** How the application was installed; it decides which update mechanism is available. */
export type UpdatePackageKind = 'appimage' | 'deb' | 'rpm' | 'pacman' | 'nsis' | 'portable' | 'mac' | 'snap' | 'unknown' | 'dev'

/** Why a check ran: auto checks stay quiet, manual checks surface errors and up-to-date states. */
export type UpdateOrigin = 'auto' | 'manual'

export interface UpdateProgress {
  /** 0–100. */
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  packageKind: UpdatePackageKind
  /** False for portable, Snap, development and unknown installs. */
  canAutoInstall: boolean
  /** Origin of the transition that produced this state. */
  origin: UpdateOrigin
  /** Version offered by the feed, when known. */
  version?: string
  releaseName?: string
  releaseNotes?: string
  releaseDate?: string
  /** ISO timestamp of the last completed check. */
  checkedAt?: string
  progress?: UpdateProgress
  /** Human-readable failure for the panel and Settings; never a stack trace. */
  error?: string
}
