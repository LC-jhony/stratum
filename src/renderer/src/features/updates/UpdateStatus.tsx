import { useEffect } from 'react'
import { formatBytes, formatSpeed, packageKindLabel, statusLabel, updatePhaseLabel, updateProgress } from '../../../../core/update'
import type { UpdatePhase } from '../../../../shared/update'
import { ipc } from '../../ipc/client'
import { useWorkbench } from '../../store/workbench'
import { Icon } from '../../ui/Icon'

const ICONS: Record<UpdatePhase, string> = {
  idle: 'refresh',
  checking: 'loading',
  available: 'cloud-download',
  downloading: 'loading',
  ready: 'check',
  'up-to-date': 'pass-filled',
  error: 'warning',
  disabled: 'info',
}

/**
 * Status-bar update affordance plus its popover. The status item only appears when there is
 * something to say; errors from the quiet background check stay hidden until the user asks.
 */
export function UpdateStatus() {
  const update = useWorkbench((s) => s.update)
  const open = useWorkbench((s) => s.updatesOpen)
  const showUpdates = useWorkbench((s) => s.showUpdates)
  const hideUpdates = useWorkbench((s) => s.hideUpdates)
  const checkUpdates = useWorkbench((s) => s.checkUpdates)
  const downloadUpdate = useWorkbench((s) => s.downloadUpdate)
  const installUpdate = useWorkbench((s) => s.installUpdate)
  const openSettings = useWorkbench((s) => s.openSettings)
  const progress = updateProgress(update)

  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') hideUpdates() }
    addEventListener('keydown', h)
    return () => removeEventListener('keydown', h)
  }, [open, hideUpdates])

  if (!update) return null
  // Packaged builds always expose the affordance; a development build only answers an explicit request.
  if (!open && update.packageKind === 'dev') return null
  const manual = update.origin === 'manual'
  const prominent = update.phase === 'available' || update.phase === 'downloading' || update.phase === 'ready'
  // Quiet background checks never put an "up to date" or "failed" label in the status bar; the
  // user only sees those after asking. Prominent states always show.
  const informs = prominent || (manual && (update.phase === 'up-to-date' || update.phase === 'error'))
  const label = informs ? statusLabel(update) : ''
  const busy = update.phase === 'checking' || update.phase === 'downloading'
  const tone = update.phase === 'ready' ? ' ready' : update.phase === 'error' && informs ? ' error' : ''

  return (
    <>
      <button
        className={`update-status${tone}`}
        title={updatePhaseLabel(update)}
        aria-label={`Software updates: ${updatePhaseLabel(update)}`}
        aria-expanded={open}
        onClick={() => (open ? hideUpdates() : showUpdates())}
      >
        <Icon id={ICONS[update.phase]} className={busy ? 'codicon-modifier-spin' : ''} />
        {label && <span className="update-label">{label}</span>}
      </button>
      {open && (
        <div className="update-pop" role="dialog" aria-label="Software updates" aria-live="polite">
          <header>
            <Icon id={ICONS[update.phase]} className={busy ? 'codicon-modifier-spin' : ''} />
            <span>Stratum updates</span>
            <button className="update-close" onClick={hideUpdates} aria-label="Close update panel"><Icon id="close" /></button>
          </header>
          <div className="update-body">
            <p className="update-version">
              Version {update.currentVersion}
              <span> · {packageKindLabel(update.packageKind)}</span>
            </p>
            <p className={`update-message${update.phase === 'error' ? ' error' : ''}`}>{updatePhaseLabel(update)}</p>
            {update.error && update.phase !== 'error' && <p className="update-message error">{update.error}</p>}

            {progress && (update.phase === 'downloading' || update.phase === 'ready') && (
              <div className="update-progress">
                <div className="update-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.percent)}>
                  <div className="update-fill" style={{ width: `${progress.percent}%` }} />
                </div>
                <span className="update-meta">
                  {Math.round(progress.percent)}%
                  {progress.total > 0 && ` · ${formatBytes(progress.transferred)} of ${formatBytes(progress.total)}`}
                  {progress.bytesPerSecond > 0 && ` · ${formatSpeed(progress.bytesPerSecond)}`}
                </span>
              </div>
            )}

            {update.phase === 'disabled' && (
              <p className="update-note">Use <b>Release notes</b> to download the latest build for your platform.</p>
            )}
            {update.phase === 'up-to-date' && update.checkedAt && (
              <p className="update-note">Checked {new Date(update.checkedAt).toLocaleString()}.</p>
            )}
            {update.releaseNotes && (update.phase === 'available' || update.phase === 'ready') && (
              <details className="update-notes">
                <summary>Release notes</summary>
                <pre>{update.releaseNotes}</pre>
              </details>
            )}
          </div>
          <footer>
            <button className="update-settings" onClick={() => { hideUpdates(); openSettings() }}>Settings</button>
            <span className="grow" />
            {update.phase === 'ready' ? (
              <button className="primary" onClick={() => void installUpdate()}>Restart and install</button>
            ) : update.phase === 'available' ? (
              <button className="primary" onClick={() => void downloadUpdate()}>Download update</button>
            ) : update.phase === 'downloading' || update.phase === 'checking' ? (
              <button className="primary" disabled>{update.phase === 'checking' ? 'Checking…' : 'Downloading…'}</button>
            ) : update.phase === 'disabled' ? (
              <button className="primary" onClick={() => void ipc.update.openReleasePage()}>Open releases</button>
            ) : (
              <button className="primary" onClick={() => void checkUpdates(false)}>{update.phase === 'error' ? 'Try again' : 'Check again'}</button>
            )}
            {update.phase !== 'disabled' && <button onClick={() => void ipc.update.openReleasePage()}>Release notes</button>}
          </footer>
        </div>
      )}
    </>
  )
}
