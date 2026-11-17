import { describe, expect, it } from 'vitest'
import {
  afterUpdateFailure,
  describeUpdateError,
  formatBytes,
  formatSpeed,
  normalizeReleaseNotes,
  packageKindLabel,
  statusLabel,
  updatePhaseLabel,
  updateProgress,
  updaterCacheDirName,
} from '../src/core/update'
import type { UpdateState } from '../src/shared/update'

const state = (patch: Partial<UpdateState>): UpdateState => ({
  phase: 'idle',
  currentVersion: '0.2.0',
  packageKind: 'appimage',
  canAutoInstall: true,
  origin: 'manual',
  ...patch,
})

describe('byte formatting', () => {
  it('uses binary units with a compact label', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 kB')
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
  it('adds the per-second suffix', () => expect(formatSpeed(2 * 1024 * 1024)).toBe('2.0 MB/s'))
})

describe('packageKindLabel', () => {
  it('names the detected install kind and falls back to a packaged build', () => {
    expect(packageKindLabel('deb')).toBe('Debian package')
    expect(packageKindLabel('appimage')).toBe('AppImage')
    expect(packageKindLabel('portable')).toBe('Portable build')
    expect(packageKindLabel(undefined)).toBe('Packaged build')
  })
})

describe('updatePhaseLabel', () => {
  it('describes every phase', () => {
    expect(updatePhaseLabel(undefined)).toBe('Loading…')
    expect(updatePhaseLabel(state({ phase: 'checking' }))).toContain('Checking')
    expect(updatePhaseLabel(state({ phase: 'available', version: '0.3.0' }))).toContain('0.3.0')
    expect(updatePhaseLabel(state({ phase: 'downloading', progress: { percent: 42, transferred: 1, total: 2, bytesPerSecond: 3 } }))).toContain('42%')
    expect(updatePhaseLabel(state({ phase: 'ready', version: '0.3.0' }))).toContain('ready')
    expect(updatePhaseLabel(state({ phase: 'up-to-date' }))).toContain('latest')
    expect(updatePhaseLabel(state({ phase: 'error', error: 'offline' }))).toBe('offline')
    expect(updatePhaseLabel(state({ phase: 'disabled' }))).toContain('unavailable')
  })
})

describe('updateProgress', () => {
  it('clamps values and tolerates missing progress', () => {
    expect(updateProgress(undefined)).toBeUndefined()
    expect(updateProgress(state({ phase: 'downloading', progress: { percent: 140, transferred: -5, total: 0, bytesPerSecond: -1 } }))).toEqual({
      percent: 100, transferred: 0, total: 0, bytesPerSecond: 0,
    })
  })
})

describe('normalizeReleaseNotes', () => {
  it('flattens per-version notes', () => {
    expect(normalizeReleaseNotes([
      { version: '0.3.0', note: 'Faster grids' },
      { version: '0.2.1', note: null },
    ])).toBe('Version 0.3.0\nFaster grids')
  })
  it('strips control characters and trims', () => {
    expect(normalizeReleaseNotes('\u0001Fixes\u0007\n\n')).toBe('Fixes')
  })
  it('returns undefined for empty notes', () => {
    expect(normalizeReleaseNotes(null)).toBeUndefined()
    expect(normalizeReleaseNotes('   ')).toBeUndefined()
  })
  it('caps very long release notes', () => {
    expect(normalizeReleaseNotes('x'.repeat(25_000))).toHaveLength(20_000)
  })
})

describe('statusLabel', () => {
  it('keeps the status bar short', () => {
    expect(statusLabel(undefined)).toBe('')
    expect(statusLabel(state({ phase: 'available', version: '0.3.0' }))).toBe('Update 0.3.0')
    expect(statusLabel(state({ phase: 'downloading', progress: { percent: 37.6, transferred: 0, total: 0, bytesPerSecond: 0 } }))).toBe('38%')
    expect(statusLabel(state({ phase: 'ready' }))).toBe('Restart to update')
  })
})

describe('update failures', () => {
  it('turns network and feed errors into actionable sentences', () => {
    expect(describeUpdateError(new Error('getaddrinfo ENOTFOUND api.github.com'))).toContain('No network connection')
    expect(describeUpdateError('net::ERR_INTERNET_DISCONNECTED')).toContain('No network connection')
    expect(describeUpdateError(new Error('Cannot find latest-linux.yml in the latest release'))).toContain('update metadata')
    expect(describeUpdateError('HttpError: 404 Not Found')).toContain('update metadata')
    expect(describeUpdateError(new Error('EACCES: permission denied'))).toContain('permissions')
    expect(describeUpdateError('sha512 checksum mismatch')).toContain('integrity check')
    expect(describeUpdateError('')).toBe('The update failed for an unknown reason.')
    expect(describeUpdateError('something odd happened')).toBe('something odd happened')
  })

  it('keeps a known or downloaded update when a later check fails', () => {
    const available = state({ phase: 'available', version: '0.3.0' })
    const failed = afterUpdateFailure(available, 'offline', '2026-01-01T00:00:00.000Z')
    expect(failed.phase).toBe('available')
    expect(failed.version).toBe('0.3.0')
    expect(failed.error).toBe('offline')
    expect(failed.checkedAt).toBe('2026-01-01T00:00:00.000Z')

    const ready = state({ phase: 'ready', version: '0.3.0' })
    expect(afterUpdateFailure(ready, 'offline').phase).toBe('ready')
    const downloading = state({ phase: 'downloading', version: '0.3.0', progress: { percent: 40, transferred: 1, total: 2, bytesPerSecond: 3 } })
    expect(afterUpdateFailure(downloading, 'offline').phase).toBe('available')
    expect(afterUpdateFailure(state({ phase: 'checking' }), 'offline').phase).toBe('error')
  })

  it('reads the updater cache directory and rejects unsafe names', () => {
    expect(updaterCacheDirName('provider: github\nupdaterCacheDirName: stratum-updater\nowner: x')).toBe('stratum-updater')
    expect(updaterCacheDirName('updaterCacheDirName: "stratum-updater"')).toBe('stratum-updater')
    expect(updaterCacheDirName('updaterCacheDirName: ../../etc')).toBeUndefined()
    expect(updaterCacheDirName('provider: github')).toBeUndefined()
  })
})
