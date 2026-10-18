import { useWorkbench } from '../store/workbench'
import { FileIcon, Icon } from '../ui/Icon'

export function Tabs() {
  const { tabs, activeTab, setActive, closeTab, connections } = useWorkbench()
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <div key={t.id} role="tab" aria-selected={t.id === activeTab} className={`tab ${t.id === activeTab ? 'active' : ''}`} onClick={() => setActive(t.id)} onAuxClick={(e) => e.button === 1 && closeTab(t.id)} title={connections.find((c) => c.id === t.connectionId)?.name}>
          {t.type === 'console' ? <FileIcon name="console.sql" fallback="terminal" /> : t.type === 'table' ? <Icon id="table" style={{ color: 'var(--vscode-charts-blue)' }} /> : <FileIcon name="diagram.svg" fallback="type-hierarchy" />}
          <span>{t.title}</span>
          <button className="close" onClick={(e) => { e.stopPropagation(); closeTab(t.id) }} aria-label="Close"><Icon id="close" /></button>
        </div>
      ))}
    </div>
  )
}
