import { useEffect, useState } from 'react'
import { formatBytes } from '../../../../core/update'
import type { DriverJar } from '../../../../shared/drivers'
import { ipc } from '../../ipc/client'
import { useT } from '../../i18n/useT'
import { useWorkbench } from '../../store/workbench'
import { Icon } from '../../ui/Icon'

const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')

/** JDBC driver libraries copied into <userData>/drivers and suggested by the data-source dialog. */
export function DriverManagerDialog() {
  const t = useT()
  const { driverManagerOpen, set } = useWorkbench()
  const [jars, setJars] = useState<DriverJar[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try { setJars(await ipc.drivers.list()); setError(undefined) }
    catch (e) { setError(clean(e)) }
  }
  useEffect(() => { if (driverManagerOpen) void load() }, [driverManagerOpen])
  if (!driverManagerOpen) return null

  const close = () => set({ driverManagerOpen: false })
  const add = async () => {
    setBusy(true)
    try { setJars(await ipc.drivers.add()); setError(undefined) }
    catch (e) { setError(clean(e)) }
    finally { setBusy(false) }
  }
  const remove = async (jar: DriverJar) => {
    if (!window.confirm(t('drivers.removeConfirm', { name: jar.name }))) return
    setBusy(true)
    try { setJars(await ipc.drivers.remove(jar.path)); setError(undefined) }
    catch (e) { setError(clean(e)) }
    finally { setBusy(false) }
  }

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section className="dialog drivers-dialog" role="dialog" aria-label={t('drivers.title')}>
        <header><Icon id="plug" /> {t('drivers.title')}<button type="button" aria-label={t('common.close')} onClick={close}><Icon id="close" /></button></header>
        <p className="hint drivers-hint"><Icon id="info" /> {t('drivers.hint')}</p>
        {error && <p className="hint error"><Icon id="triangle-alert" />{error}</p>}
        <div className="driver-list">
          {!jars.length && <p className="hint"><Icon id="info" /> {t('drivers.empty')}</p>}
          {jars.map((jar) => (
            <article className="driver-row" key={jar.path}>
              <Icon id="file" className="driver-icon" />
              <div className="driver-meta">
                <span className="driver-name">{jar.name}</span>
                <span className="driver-detail">{formatBytes(jar.size)} · {new Date(jar.modifiedAt).toLocaleDateString()} · <code>{jar.path}</code></span>
              </div>
              <button type="button" title={t('drivers.reveal')} onClick={() => void ipc.drivers.reveal(jar.path)}><Icon id="folder-opened" /></button>
              <button type="button" title={t('drivers.remove')} disabled={busy} onClick={() => void remove(jar)}><Icon id="close" /></button>
            </article>
          ))}
        </div>
        <footer>
          <span className="hint">{t('drivers.count', { count: jars.length })}</span>
          <span className="grow" />
          <button type="button" onClick={() => void ipc.drivers.openFolder()}><Icon id="folder-opened" /> {t('drivers.folder')}</button>
          <button className="primary" type="button" disabled={busy} onClick={() => void add()}><Icon id="add" /> {busy ? t('drivers.adding') : t('drivers.add')}</button>
        </footer>
      </section>
    </div>
  )
}
