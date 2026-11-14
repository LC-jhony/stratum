import { useEffect, useState, type MouseEvent } from 'react'
import markDark from '../assets/brand/stratum-mark-on-dark.svg'
import markLight from '../assets/brand/stratum-mark-on-light.svg'
import { ipc } from '../ipc/client'
import { Icon } from '../ui/Icon'

/**
 * In-app title bar. macOS keeps its traffic lights (hiddenInset), Windows keeps the native caption
 * overlay (Window Controls Overlay), and Linux draws its own controls so minimize/maximize/close are
 * always present — including under Wayland/GNOME, where native decorations have disappeared.
 */
export function TitleBar({ title, light, onCommand }: { title?: string; light: boolean; onCommand: (cmd: string) => void }) {
  const [maximized, setMaximized] = useState(false)
  const isMac = ipc.platform === 'darwin'
  const isLinux = ipc.platform === 'linux'

  useEffect(() => {
    if (!isLinux) return
    let live = true
    void ipc.window.isMaximized().then((v) => { if (live) setMaximized(v) })
    const off = ipc.window.onMaximized(setMaximized)
    return () => { live = false; off() }
  }, [isLinux])

  const openMenu = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    void ipc.window.showMenu({ x: Math.round(r.left), y: Math.round(r.bottom) })
  }
  // Native drag regions normally own this gesture; when the renderer does receive it, never toggle
  // because the user double-clicked a button or the search field.
  const maximizeOnDoubleClick = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('button, kbd')) return
    void ipc.window.toggleMaximize()
  }
  const shortcut = isMac ? '⇧⌘A' : 'Ctrl Shift A'

  return (
    <header
      className="titlebar"
      onDoubleClick={isLinux ? maximizeOnDoubleClick : undefined}
    >
      <div className="titlebar-left">
        {!isMac && (
          <button className="titlebar-menu" aria-label="Application menu" title="Application menu" onClick={openMenu}>
            <Icon id="menu" />
          </button>
        )}
        <img className="titlebar-mark" src={light ? markLight : markDark} alt="" draggable={false} />
        <span className="titlebar-name">Stratum</span>
        {title && <><span className="titlebar-sep" aria-hidden>·</span><span className="titlebar-doc" title={title}>{title}</span></>}
      </div>
      <button className="titlebar-search" onClick={() => onCommand('palette')} title={`Find Action (${shortcut})`}>
        <Icon id="search" />
        <span className="titlebar-search-label">Search actions</span>
        <kbd>{shortcut}</kbd>
      </button>
      <div className="titlebar-right">
        {isLinux && (
          <div className="window-controls">
            <button aria-label="Minimize" title="Minimize" onClick={() => void ipc.window.minimize()}><Icon id="chrome-minimize" /></button>
            <button aria-label={maximized ? 'Restore' : 'Maximize'} title={maximized ? 'Restore' : 'Maximize'} onClick={() => void ipc.window.toggleMaximize()}><Icon id={maximized ? 'chrome-restore' : 'chrome-maximize'} /></button>
            <button className="close" aria-label="Close" title="Close" onClick={() => void ipc.window.close()}><Icon id="chrome-close" /></button>
          </div>
        )}
      </div>
    </header>
  )
}
