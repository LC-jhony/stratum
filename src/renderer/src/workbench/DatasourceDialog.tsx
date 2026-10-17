import { useState } from 'react'
import type { ConnectionConfig, DriverKind } from '../../../shared/types'
import { DIALECTS } from '../../../shared/dialects'
import { useWorkbench } from '../store/workbench'
import { Icon } from './Icon'

const KINDS: { id: DriverKind; label: string; port?: number }[] = [
  { id: 'postgres', label: 'PostgreSQL', port: 5432 }, { id: 'mysql', label: 'MySQL / MariaDB', port: 3306 },
  { id: 'sqlite', label: 'SQLite' }, { id: 'jdbc', label: 'Other (JDBC)' },
]
const blank = (): ConnectionConfig => ({ id: crypto.randomUUID(), name: '', kind: 'postgres', host: 'localhost', port: 5432, user: '', password: '', database: '' })

export function DatasourceDialog() {
  const { dialog, set, saveConnection, connect } = useWorkbench()
  const [c, setC] = useState<ConnectionConfig>(() => dialog?.editing ?? blank())
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null), [busy, setBusy] = useState(false)
  if (!dialog) return null
  const up = (p: Partial<ConnectionConfig>) => { setC((x) => ({ ...x, ...p })); setTest(null) }
  const kind = (k: DriverKind) => up({ kind: k, port: KINDS.find((x) => x.id === k)?.port, ...(k === 'jdbc' && !c.jdbc ? { jdbc: { url: '', driverPath: '', dialect: 'generic' as const } } : {}) })
  const name = c.name || (c.kind === 'sqlite' ? (c.filePath?.split(/[\\/]/).pop() ?? 'sqlite') : c.database || c.host || 'data source')
  const ok = c.kind === 'sqlite' ? !!c.filePath : c.kind === 'jdbc' ? !!c.jdbc?.url && !!c.jdbc.driverPath : !!c.host

  const doTest = async () => { setBusy(true); const r = await window.stratum.connections.test({ ...c, name }); setBusy(false); setTest({ ok: r.ok, text: r.ok ? `Succeeded · ${c.kind} ${r.version ?? ''}` : (r.error ?? 'Failed') }) }
  const save = async () => { const cfg = { ...c, name }; await saveConnection(cfg); set({ dialog: null }); void connect(cfg.id) }
  const pick = async (apply: (p: string) => void, exts?: string[]) => { const f = await window.stratum.dialogs.pickFile(exts ? [{ name: 'Files', extensions: exts }] : undefined); if (f) apply(f) }

  const F = ({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) => <label className={`field ${wide ? 'span-2' : ''}`}><span>{label}</span>{children}</label>
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && set({ dialog: null })}>
      <div className="dialog" role="dialog" aria-label="Data Source">
        <header><Icon id="database" /> Data Sources and Drivers<button onClick={() => set({ dialog: null })}><Icon id="close" /></button></header>
        <div className="form">
          <F label="Name" wide><input autoFocus value={c.name} placeholder={name} onChange={(e) => up({ name: e.target.value })} /></F>
          <F label="Type" wide><select value={c.kind} onChange={(e) => kind(e.target.value as DriverKind)}>{KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select></F>
          {(c.kind === 'postgres' || c.kind === 'mysql') && <>
            <F label="Host"><input value={c.host ?? ''} onChange={(e) => up({ host: e.target.value })} /></F>
            <F label="Port"><input type="number" value={c.port ?? ''} onChange={(e) => up({ port: Number(e.target.value) || undefined })} /></F>
            <F label="User"><input value={c.user ?? ''} onChange={(e) => up({ user: e.target.value })} /></F>
            <F label="Password"><input type="password" value={c.password ?? ''} onChange={(e) => up({ password: e.target.value })} /></F>
            <F label="Database" wide><input value={c.database ?? ''} onChange={(e) => up({ database: e.target.value })} /></F>
            <label className="check span-2"><input type="checkbox" checked={!!c.ssl} onChange={(e) => up({ ssl: e.target.checked })} /> Use SSL</label>
          </>}
          {c.kind === 'sqlite' && <F label="File" wide><div className="with-btn"><input value={c.filePath ?? ''} placeholder="path/to/database.db  (or :memory:)" onChange={(e) => up({ filePath: e.target.value })} /><button onClick={() => void pick((f) => up({ filePath: f }), ['db', 'sqlite', 'sqlite3', 'db3'])}>…</button></div></F>}
          {c.kind === 'jdbc' && <>
            <F label="JDBC URL" wide><input value={c.jdbc?.url ?? ''} placeholder="jdbc:oracle:thin:@//host:1521/service" onChange={(e) => up({ jdbc: { ...c.jdbc!, url: e.target.value } })} /></F>
            <F label="Driver file" wide><div className="with-btn"><input value={c.jdbc?.driverPath ?? ''} placeholder="ojdbc11.jar (file, folder or archive)" onChange={(e) => up({ jdbc: { ...c.jdbc!, driverPath: e.target.value } })} /><button onClick={() => void pick((f) => up({ jdbc: { ...c.jdbc!, driverPath: f } }), ['jar', 'zip'])}>…</button></div></F>
            <F label="Driver class"><input value={c.jdbc?.driverClass ?? ''} placeholder="optional" onChange={(e) => up({ jdbc: { ...c.jdbc!, driverClass: e.target.value } })} /></F>
            <F label="SQL dialect"><select value={c.jdbc?.dialect} onChange={(e) => up({ jdbc: { ...c.jdbc!, dialect: e.target.value as never } })}>{DIALECTS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</select></F>
            <F label="User"><input value={c.user ?? ''} onChange={(e) => up({ user: e.target.value })} /></F>
            <F label="Password"><input type="password" value={c.password ?? ''} onChange={(e) => up({ password: e.target.value })} /></F>
          </>}
          <label className="check span-2"><input type="checkbox" checked={!!c.readonly} onChange={(e) => up({ readonly: e.target.checked })} /> Read-only</label>
        </div>
        <footer>
          <button onClick={() => void doTest()} disabled={!ok || busy}>{busy ? 'Testing…' : 'Test Connection'}</button>
          {test && <span className={`test ${test.ok ? 'ok' : 'bad'}`}><Icon id={test.ok ? 'pass' : 'error'} /> {test.text}</span>}
          <span className="grow" />
          <button onClick={() => set({ dialog: null })}>Cancel</button>
          <button className="primary" disabled={!ok} onClick={() => void save()}>OK</button>
        </footer>
      </div>
    </div>
  )
}
