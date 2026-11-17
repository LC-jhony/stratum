import { useWorkbench } from '../store/workbench'
import { FileIcon, Icon } from '../ui/Icon'

export function Tabs() {
  const { tabs, activeTab, setActive, closeTab, connections } = useWorkbench()
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <div key={t.id} role="tab" aria-selected={t.id === activeTab} className={`tab ${t.id === activeTab ? 'active' : ''}`} onClick={() => setActive(t.id)} onAuxClick={(e) => e.button === 1 && closeTab(t.id)} title={t.type === 'console' && t.path ? t.path : connections.find((c) => c.id === t.connectionId)?.name}>
          {t.type === 'console' ? <FileIcon icon="database" fallback="terminal" /> : t.type === 'table' ? <FileIcon icon="table" fallback="table" style={{ color: 'var(--vscode-charts-blue)' }} /> : t.type === 'debug' ? <Icon id="debug-alt" style={{ color: 'var(--vscode-charts-red, var(--accent))' }} /> : <FileIcon name="diagram.svg" fallback="type-hierarchy" />}
          <span>{t.title}{t.type === 'console' && t.dirty ? ' •' : ''}</span>
          <button className="close" onClick={(e) => { e.stopPropagation(); closeTab(t.id) }} aria-label="Close"><Icon id="close" /></button>
        </div>
      ))}
    </div>
  )
}
