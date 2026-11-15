import { useEffect, useMemo, useState } from 'react'
import type { ExtensionView } from '../../../../shared/extensions'
import { ipc } from '../../ipc/client'
import { useT } from '../../i18n/useT'
import { useWorkbench } from '../../store/workbench'
import { Icon } from '../../ui/Icon'

const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')

/** Installed extensions with their declared contributions and a persisted enable/disable toggle. */
export function ExtensionsDialog() {
  const t = useT()
  const { extensionsOpen, set } = useWorkbench()
  const [items, setItems] = useState<ExtensionView[]>([])
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()

  const load = async () => {
    setLoading(true)
    try { setItems(await ipc.extensions.list()); setError(undefined) }
    catch (e) { setError(clean(e)) }
    finally { setLoading(false) }
  }
  useEffect(() => { if (extensionsOpen) { setFilter(''); void load() } }, [extensionsOpen])
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q
      ? items.filter((i) => `${i.name} ${i.id} ${i.description}`.toLowerCase().includes(q))
      : items
  }, [items, filter])
  if (!extensionsOpen) return null

  const close = () => set({ extensionsOpen: false })
  const toggle = async (item: ExtensionView) => {
    setBusy(item.id)
    try { setItems(await ipc.extensions.setEnabled(item.id, !item.enabled)); setError(undefined) }
    catch (e) { setError(clean(e)) }
    finally { setBusy(undefined) }
  }
  const enabled = items.filter((i) => i.enabled).length

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section className="dialog extensions-dialog" role="dialog" aria-label={t('extensions.title')}>
        <header><Icon id="plug" /> {t('extensions.title')}<button type="button" aria-label={t('common.close')} onClick={close}><Icon id="close" /></button></header>
        <div className="filter"><Icon id="search" /><input autoFocus placeholder={t('extensions.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
        {error && <p className="hint error"><Icon id="triangle-alert" />{t('extensions.error', { error })}</p>}
        <div className="extension-list">
          {loading && <p className="hint"><Icon id="loading" /> {t('extensions.loading')}</p>}
          {!loading && !items.length && <p className="hint"><Icon id="info" /> {t('extensions.none')}</p>}
          {!loading && !!items.length && !shown.length && <p className="hint"><Icon id="info" /> {t('extensions.empty')}</p>}
          {shown.map((item) => (
            <article className={`extension-row${item.enabled ? '' : ' off'}`} key={item.id}>
              <div className="extension-head">
                <span className="extension-name">{item.name}</span>
                <span className="extension-version">{item.version}</span>
                {item.builtin && <span className="extension-badge">{t('extensions.builtin')}</span>}
                {item.mandatory && <span className="extension-badge required">{t('extensions.mandatory')}</span>}
                <label className="extension-toggle" title={item.enabled ? t('extensions.enabled') : t('extensions.disabled')}>
                  <input
                    type="checkbox"
                    checked={item.enabled}
                    disabled={item.mandatory || busy === item.id}
                    onChange={() => void toggle(item)}
                    aria-label={`${item.enabled ? t('extensions.enabled') : t('extensions.disabled')}: ${item.name}`}
                  />
                </label>
              </div>
              <p className="extension-desc">{item.description}</p>
              <div className="extension-meta">
                <code>{item.id}</code>
                {item.author && <span>{t('extensions.by', { author: item.author })}</span>}
                {!!item.commands?.length && <span>{t('extensions.commands', { count: item.commands.length })}</span>}
                {!!item.drivers?.length && <span>{t('extensions.drivers', { list: item.drivers.join(', ') })}</span>}
              </div>
            </article>
          ))}
        </div>
        <footer><span className="hint">{t('extensions.footer', { enabled, total: items.length })}</span><span className="grow" /><button className="primary" onClick={close}>{t('common.close')}</button></footer>
      </section>
    </div>
  )
}
