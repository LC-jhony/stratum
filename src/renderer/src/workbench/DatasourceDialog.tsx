import { Fragment, useState } from 'react'
import { ipc } from '../ipc/client'
import type { CSSProperties, ReactNode } from 'react'
import type { ConnectionConfig, ConnectionView, DialectId, DriverKind, SshConfig } from '../../../shared/types'
import { DIALECTS } from '../../../core/dialects'
import { inferDockerKind, publishedPorts, type DockerContainer, type DockerPort } from '../../../core/docker'
import { useWorkbench } from '../store/workbench'
import { Icon } from '../ui/Icon'
import { DbIcon, DbLogo } from './dbIcons'

/**
 * "Connect to server" — the New Data Source / Data Sources and Drivers dialog.
 *
 * Markup and geometry follow the redesign sheet (two rows of server types, Config tabs, port
 * steppers, switch toggles); every colour comes from the active theme through the --vscode-*
 * variables the workbench sets, so Carbon, Min and third-party themes all repaint it. The
 * class names are all .ds-* so nothing leaks into the rest of the workbench (styles.css).
 *
 * Server types this build has no transport for stay visible but disabled; the ones that do select
 * their kind: SQL Server, Db2, Oracle and ClickHouse ride the JDBC sidecar with their dialect
 * prefilled, while MongoDB, Redis, Elasticsearch and Cassandra connect through native drivers. The
 * SSH tab is a real connection helper (any network source can tunnel through it); both proxies keep
 * the sheet's controls so the dialog stays complete, and the footer says so when they are switched
 * on.
 */

interface ServerType {
  id: string
  label: string
  icon: string
  /** undefined → no transport in this build: rendered dimmed and not selectable. */
  kind?: DriverKind
  dialect?: DialectId
  port?: number
  /** JDBC connection string preset for the JDBC-backed types. */
  url?: string
  /** Helper panes that fill a connection instead of selecting a kind (Docker today). */
  action?: 'docker'
}

const ROW1: ServerType[] = [
  { id: 'mysql', label: 'MySQL', icon: 'mysql', kind: 'mysql', port: 3306 },
  { id: 'mariadb', label: 'MariaDB', icon: 'mariadb', kind: 'mysql', port: 3306 },
  { id: 'postgres', label: 'PostgreSQL', icon: 'postgres', kind: 'postgres', port: 5432 },
  { id: 'sqlite', label: 'SQLite', icon: 'sqlite', kind: 'sqlite' },
  { id: 'mssql', label: 'SQL Server', icon: 'sqlserver', kind: 'jdbc', dialect: 'mssql', url: 'jdbc:sqlserver://localhost:1433' },
  { id: 'db2', label: 'Db2', icon: 'db2', kind: 'jdbc', dialect: 'db2', url: 'jdbc:db2://localhost:50000/sample' },
  { id: 'oracle', label: 'Oracle', icon: 'oracle', kind: 'jdbc', dialect: 'oracle', url: 'jdbc:oracle:thin:@//localhost:1521/FREEPDB1' },
  { id: 'kingbase', label: 'Kingbase', icon: 'kingbase', kind: 'postgres', port: 54321 },
  { id: 'clickhouse', label: 'ClickHouse', icon: 'clickhouse', kind: 'jdbc', dialect: 'clickhouse', url: 'jdbc:clickhouse://localhost:8123/default' },
  { id: 'jdbc', label: 'JDBC', icon: 'jdbc', kind: 'jdbc', url: 'jdbc:' },
]
const ROW2: ServerType[] = [
  { id: 'ssh', label: 'SSH', icon: 'ssh' },
  { id: 'docker', label: 'Docker', icon: 'docker', action: 'docker' },
  { id: 'redis', label: 'Redis', icon: 'redis', kind: 'redis', port: 6379 },
  { id: 'elastic', label: 'ElasticSearch', icon: 'elastic', kind: 'elastic', port: 9200 },
  { id: 'mongodb', label: 'MongoDB', icon: 'mongodb', kind: 'mongodb', port: 27017 },
  { id: 's3', label: 'S3', icon: 's3', kind: 's3', port: 443 },
  { id: 'ftp', label: 'FTP', icon: 'ftp', kind: 'ftp', port: 21 },
  { id: 'kafka', label: 'Kafka', icon: 'kafka', kind: 'kafka', port: 9092 },
  { id: 'rabbitmq', label: 'RabbitMQ', icon: 'rabbitmq', kind: 'rabbitmq', port: 15672 },
  { id: 'cassandra', label: 'Cassandra', icon: 'cassandra', kind: 'cassandra', port: 9042 },
  { id: 'more', label: 'More', icon: 'more' },
]
const PIPE_AFTER = new Set(['postgres', 'mssql', 'oracle', 'docker', 'mongodb', 'ftp', 'cassandra'])
const ALL_TYPES = [...ROW1, ...ROW2]

/** Unix socket defaults behind the Main tab's "Use" button (Host is ignored while one is set). */
const SOCKET_DEFAULT: Partial<Record<DriverKind, string>> = { mysql: '/var/run/mysqld/mysqld.sock', postgres: '/var/run/postgresql' }

const typeOf = (c: ConnectionConfig): string =>
  c.kind === 'jdbc' ? ALL_TYPES.find((t) => t.kind === 'jdbc' && (t.dialect ?? 'generic') === (c.jdbc?.dialect ?? 'generic'))?.id ?? 'jdbc' : c.kind
const blank = (): ConnectionConfig => ({ id: crypto.randomUUID(), name: '', kind: 'postgres', host: 'localhost', port: 5432, user: '', password: '', database: '' })

/* ------------------------------------------------------------------ small controls */

const Lbl = ({ className = '', req, dim, style, children }: { className?: string; req?: boolean; dim?: boolean; style?: CSSProperties; children: ReactNode }) => (
  <span className={`ds-lbl${req ? ' req' : ''}${dim ? ' dim' : ''} ${className}`} style={style}>{children}</span>
)

const Stepper = ({ value, onChange, disabled, label }: { value?: number; onChange: (v: number) => void; disabled?: boolean; label: string }) => (
  <div className={`ds-stepper${disabled ? ' off' : ''}`}>
    <button type="button" disabled={disabled} aria-label={`Decrease ${label}`} onClick={() => onChange(Math.max(1, (value ?? 0) - 1))}>−</button>
    <input type="number" aria-label={label} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
    <button type="button" disabled={disabled} aria-label={`Increase ${label}`} onClick={() => onChange(Math.min(65535, (value ?? 0) + 1))}>+</button>
  </div>
)
const Switch = ({ checked, onChange, disabled, label, style }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; style?: CSSProperties }) => (
  <button type="button" role="switch" className="ds-sw" style={style} aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />
)
const Check = ({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) => (
  <button type="button" role="checkbox" className="ds-cb" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />
)
const Premium = () => <i className="ds-premium">Premium Only</i>

const Seg = ({ options, value, onChange, tight }: { options: { id: string; label: string; disabled?: boolean; premium?: boolean }[]; value: string; onChange: (v: string) => void; tight?: boolean }) => (
  <div className={`ds-seg-group${tight ? ' tight' : ''}`} role="radiogroup">
    {options.map((o) => {
      const seg = (
        <button type="button" role="radio" key={o.id} className={`ds-seg${value === o.id ? ' on' : ''}`} aria-checked={value === o.id} disabled={o.disabled} onClick={() => onChange(o.id)}>{o.label}</button>
      )
      return o.premium ? <span className="ds-badge-host" key={o.id}>{seg}<Premium /></span> : seg
    })}
  </div>
)

type Note = { tone: 'ok' | 'bad' | 'info'; text: string }

/** Sheet-only controls. They keep their own state — nothing here reaches the drivers yet. */
interface Draft { scope: string; events: boolean; triggers: boolean; connString: boolean }
const DRAFT: Draft = { scope: 'global', events: false, triggers: false, connString: false }

/** Docker helper state: where the daemon is and what the last scan found. Never persisted. */
interface DockerHelper {
  mode: 'socket' | 'tcp'
  socketPath: string
  host: string
  port: number
  ssl: boolean
  busy: boolean
  scanned: boolean
  containers?: DockerContainer[]
  error?: string
}
const DOCKER_INITIAL: DockerHelper = {
  mode: 'socket',
  socketPath: '/var/run/docker.sock',
  host: '127.0.0.1',
  port: 2375,
  ssl: false,
  busy: false,
  scanned: false,
}

/** Electron wraps IPC failures; keep the service message for the inline error. */
const cleanIpcError = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')

export function DatasourceDialog() {
  const { dialog, set, saveConnection, connect } = useWorkbench()
  const [c, setC] = useState<ConnectionConfig>(() => {
    const view = dialog?.editing
    if (!view) return blank()
    const { hasPassword: _hasPassword, ssh, ...rest } = view
    const sshRest = ssh
      ? (() => {
          const { hasPassword: _sshHasPassword, hasPassphrase: _sshHasPassphrase, ...rest } = ssh
          return rest
        })()
      : undefined
    return {
      ...rest,
      password: undefined,
      ssh: sshRest ? { ...sshRest, password: undefined, passphrase: undefined } : undefined,
    }
  })
  const [type, setType] = useState(() => typeOf(c))
  const [tab, setTab] = useState<'main' | 'ssh' | 'socks' | 'http'>('main')
  const [draft, setDraft] = useState<Draft>(DRAFT)
  const [note, setNote] = useState<Note | null>(null)
  const [busy, setBusy] = useState(false)
  const [dockerHelper, setDockerHelper] = useState<DockerHelper | null>(null)
  if (!dialog) return null
  const storedPassword = !!dialog.editing?.hasPassword
  const storedSshPassword = !!dialog.editing?.ssh?.hasPassword
  const storedSshPassphrase = !!dialog.editing?.ssh?.hasPassphrase
  const passwordPlaceholder = storedPassword ? 'Stored password — leave blank to keep' : 'Password'
  const sshPasswordPlaceholder = storedSshPassword ? 'Stored password — leave blank to keep' : 'Password'
  const passphrasePlaceholder = storedSshPassphrase ? 'Stored passphrase — leave blank to keep' : 'Key passphrase'

  const up = (p: Partial<ConnectionConfig>) => { setC((x) => ({ ...x, ...p })); setNote(null) }
  const d = (p: Partial<Draft>) => setDraft((x) => ({ ...x, ...p }))
  const soon = (what: string) => setNote({ tone: 'info', text: `${what} is not available in this build yet.` })
  const sql = c.kind === 'sqlite'

  const pickType = (t: ServerType) => {
    if (t.action === 'docker') {
      openDocker()
      return
    }
    const kind = t.kind
    if (!kind) return
    setDockerHelper(null)
    setType(t.id)
    setC((x) =>
      kind === 'jdbc'
        ? { ...x, kind, port: undefined, uri: undefined, authSource: undefined, jdbc: { url: x.jdbc?.url || t.url || 'jdbc:', driverPath: x.jdbc?.driverPath ?? '', driverClass: x.jdbc?.driverClass, dialect: t.dialect ?? 'generic' } }
        : { ...x, kind, port: t.port, jdbc: undefined, uri: kind === 'mongodb' ? x.uri : undefined, authSource: kind === 'mongodb' ? x.authSource : undefined },
    )
    setNote(null)
  }

  const name = c.name || (sql ? (c.filePath?.split(/[\\/]/).pop() ?? 'sqlite') : c.kind === 'jdbc' ? c.jdbc?.url || 'jdbc' : c.database || c.host || 'data source')
  const uriSet = c.kind === 'mongodb' && !!c.uri?.trim()
  const sshCfg = c.ssh ?? { enabled: false }
  const sshOn = !!sshCfg.enabled
  const sshAuth = sshCfg.authType ?? 'auto'
  /** Required SSH fields for the chosen auth mode; the tunnel itself is validated again in main. */
  const sshOk = !sshOn || (!!sshCfg.host?.trim() && !!sshCfg.user?.trim()
    && (sshAuth !== 'password' || !!sshCfg.password || storedSshPassword) && (sshAuth !== 'privateKey' || !!sshCfg.privateKeyPath?.trim()))
  const ok = (sql ? !!c.filePath : c.kind === 'mongodb' ? uriSet || !!c.host : c.kind === 'jdbc' ? !!c.jdbc?.url && !!c.jdbc.driverPath : c.kind === 's3' ? true : !!c.host) && sshOk
  const hint = dockerHelper
    ? 'Scan the Docker daemon and pick a published port to fill Host/Port; the server type follows the image when it is recognized.'
    : !sshOk ? 'Complete the SSH tunnel settings.' : ok ? 'Ready.' : sql ? 'Pick the database file first.' : c.kind === 'mongodb' ? 'Connection string or host is required.' : c.kind === 'jdbc' ? 'JDBC URL and driver file are required.' : c.kind === 'rabbitmq' ? 'Set the Management API host (port 15672 by default).' : 'Host and port are required.'

  const doTest = async () => {
    setBusy(true)
    const r = await ipc.connections.test({ ...c, name })
    setBusy(false)
    setNote(r.ok ? { tone: 'ok', text: `Succeeded · ${c.kind} ${r.version ?? ''}`.trim() } : { tone: 'bad', text: r.error ?? 'Failed' })
  }
  const save = async (thenConnect: boolean) => {
    const cfg = { ...c, name }
    await saveConnection(cfg)
    set({ dialog: null })
    if (thenConnect) void connect(cfg.id)
  }
  const pick = async (apply: (p: string) => void, exts?: string[]) => { const f = await ipc.dialogs.pickFile(exts ? [{ name: 'Files', extensions: exts }] : undefined); if (f) apply(f) }

  /* --- Docker helper: read-only container/port picker that fills the form --- */
  const scanDocker = async (state: DockerHelper | null) => {
    if (!state) return
    setDockerHelper((x) => (x ? { ...x, busy: true, error: undefined } : x))
    try {
      const containers = await ipc.docker.list({
        socketPath: state.mode === 'socket' ? state.socketPath : undefined,
        host: state.mode === 'tcp' ? state.host : undefined,
        port: state.mode === 'tcp' ? state.port : undefined,
        ssl: state.mode === 'tcp' ? state.ssl : undefined,
      })
      setDockerHelper((x) => (x ? { ...x, busy: false, scanned: true, containers, error: undefined } : x))
    } catch (e) {
      setDockerHelper((x) => (x ? { ...x, busy: false, scanned: true, containers: undefined, error: cleanIpcError(e) } : x))
    }
  }

  const openDocker = () => {
    setTab('main')
    setType('docker')
    setNote(null)
    const next: DockerHelper = { ...(dockerHelper ?? DOCKER_INITIAL), error: undefined }
    setDockerHelper(next)
    void scanDocker(next)
  }

  const closeDocker = () => {
    if (!dockerHelper) return
    setDockerHelper(null)
    setType(typeOf(c))
  }

  const goTab = (next: typeof tab) => {
    if (next !== 'main') closeDocker()
    setTab(next)
  }

  const patchDocker = (patch: Partial<DockerHelper>) => setDockerHelper((x) => (x ? { ...x, ...patch } : x))

  const useDockerPort = (container: DockerContainer, port: DockerPort) => {
    const publicPort = port.publicPort
    if (!dockerHelper || !publicPort) return
    if (sshOn) {
      setNote({ tone: 'info', text: 'Disable the SSH tunnel first: published container ports are local.' })
      return
    }
    const host = dockerHelper.mode === 'tcp' ? dockerHelper.host.trim() || '127.0.0.1' : '127.0.0.1'
    const guess = inferDockerKind(container.image)
    if (!guess && (c.kind === 'sqlite' || c.kind === 'jdbc')) {
      setNote({ tone: 'info', text: `Could not infer the server type from ${container.image}. Pick a type above, then use the port again.` })
      return
    }
    setC((x) => ({
      ...x,
      kind: guess?.kind ?? x.kind,
      host,
      port: publicPort,
      uri: undefined,
      authSource: undefined,
      socketPath: undefined,
      jdbc: undefined,
    }))
    setType(guess ? guess.tileId : typeOf(c))
    setDockerHelper(null)
    setNote({ tone: 'ok', text: `Using ${container.name} at ${host}:${publicPort}${guess ? ` — ${guess.label}` : ''}` })
  }

  const typeRow = (list: ServerType[]) => (
    <div className="ds-st-row" role="presentation">
      {list.map((t) => (
        <Fragment key={t.id}>
          <button
            type="button"
            role="tab"
            aria-selected={type === t.id}
            className={`ds-st${type === t.id ? ' on' : ''}`}
            disabled={!t.kind && !t.action}
            title={t.kind || t.action ? t.label : `${t.label} — no transport in this build yet`}
            onClick={() => pickType(t)}
          >
            <DbIcon name={t.icon} size={16} />{t.label}
          </button>
          {PIPE_AFTER.has(t.id) && <span className="ds-pipe" aria-hidden="true" />}
        </Fragment>
      ))}
    </div>
  )

  const features = (label: string, children: ReactNode) => <div className="ds-row-full ds-features"><Lbl style={{ width: 176 }}>{label}</Lbl>{children}</div>

  /* --- Main tab: network databases (the sheet's own layout) --- */
  const netFields = (
    <Fragment>
      <Lbl className="ds-c1" req>Host</Lbl>
      <input className="ds-field ds-c2" value={c.host ?? ''} placeholder="localhost" onChange={(e) => up({ host: e.target.value })} />
      <Lbl className="ds-c4" req>Port</Lbl>
      <div className="ds-c5"><Stepper label="Port" value={c.port} onChange={(port) => up({ port })} /></div>

      <Lbl className="ds-c1" req>Username</Lbl>
      <input className="ds-field ds-c2" value={c.user ?? ''} onChange={(e) => up({ user: e.target.value })} />
      <Lbl className="ds-c4" req>Password</Lbl>
      <input className="ds-field ds-c5" type="password" placeholder={passwordPlaceholder} value={c.password ?? ''} onChange={(e) => up({ password: e.target.value })} />

      <Lbl className="ds-c1">Database</Lbl>
      <input className="ds-field ds-c2" placeholder="Database" value={c.database ?? ''} onChange={(e) => up({ database: e.target.value })} />
      <button className="ds-btn ds-btn-sm ds-c4 ds-start" type="button" onClick={() => soon('Advanced options')}><Icon id="settings-gear" />Advanced</button>

      <Lbl className="ds-c1">Socket Path</Lbl>
      <input className="ds-field ds-c2" placeholder="e.g. /var/run/mysqld/mysqld.sock" value={c.socketPath ?? ''} onChange={(e) => up({ socketPath: e.target.value })} />
      <button className="ds-btn ds-btn-sm ds-c4 ds-start" type="button" title="Fill the default socket path" disabled={!SOCKET_DEFAULT[c.kind]} onClick={() => up({ socketPath: SOCKET_DEFAULT[c.kind] ?? '' })}><DbIcon name="tools" size={15} />Use</button>

      {features('Features', (
        <Fragment>
          <Check checked={draft.events} onChange={(events) => d({ events })} label="Event" /><Lbl>Event</Lbl>
          <Check checked={draft.triggers} onChange={(triggers) => d({ triggers })} label="Trigger" /><Lbl>Trigger</Lbl>
          <Check checked={!!c.readonly} onChange={(readonly) => up({ readonly })} label="Read-only" /><Lbl>Read-only</Lbl>
        </Fragment>
      ))}

      <div className="ds-row-full">
        <Lbl style={{ width: 190 }}>Use Connection String</Lbl>
        <Switch label="Use Connection String" checked={draft.connString} onChange={(connString) => d({ connString })} />
        <Lbl style={{ marginLeft: 50 }}>SSL</Lbl>
        <Switch label="SSL" style={{ marginLeft: 26 }} checked={!!c.ssl} onChange={(ssl) => up({ ssl })} />
      </div>
    </Fragment>
  )

  /* --- Main tab: MongoDB --- */
  const mongoFields = (
    <Fragment>
      <Lbl className="ds-c1">Connection string</Lbl>
      <input className="ds-field ds-wide" placeholder="mongodb://localhost:27017/db  (optional — overrides the fields below)" value={c.uri ?? ''} onChange={(e) => up({ uri: e.target.value })} />

      <Lbl className="ds-c1" req dim={uriSet}>Host</Lbl>
      <input className="ds-field ds-c2" value={c.host ?? ''} placeholder="localhost" disabled={uriSet} onChange={(e) => up({ host: e.target.value })} />
      <Lbl className="ds-c4" req dim={uriSet}>Port</Lbl>
      <div className="ds-c5"><Stepper label="Port" value={c.port} disabled={uriSet} onChange={(port) => up({ port })} /></div>

      <Lbl className="ds-c1" dim={uriSet}>Database</Lbl>
      <input className="ds-field ds-c2" placeholder="Database" value={c.database ?? ''} disabled={uriSet} onChange={(e) => up({ database: e.target.value })} />
      <Lbl className="ds-c4" dim={uriSet}>Auth source</Lbl>
      <input className="ds-field ds-c5" placeholder="auth database (default: admin)" value={c.authSource ?? ''} disabled={uriSet} onChange={(e) => up({ authSource: e.target.value })} />

      <Lbl className="ds-c1" dim={uriSet}>Username</Lbl>
      <input className="ds-field ds-c2" value={c.user ?? ''} disabled={uriSet} onChange={(e) => up({ user: e.target.value })} />
      <Lbl className="ds-c4" dim={uriSet}>Password</Lbl>
      <input className="ds-field ds-c5" type="password" placeholder={passwordPlaceholder} value={c.password ?? ''} disabled={uriSet} onChange={(e) => up({ password: e.target.value })} />

      {features('Options', (
        <Fragment>
          <Check checked={!!c.readonly} onChange={(readonly) => up({ readonly })} label="Read-only" /><Lbl>Read-only</Lbl>
        </Fragment>
      ))}
    </Fragment>
  )

  /* --- Main tab: Redis (host/port + ACL + database index) --- */
  const redisFields = (
    <Fragment>
      <Lbl className="ds-c1" req>Host</Lbl>
      <input className="ds-field ds-c2" value={c.host ?? ''} placeholder="localhost" onChange={(e) => up({ host: e.target.value })} />
      <Lbl className="ds-c4" req>Port</Lbl>
      <div className="ds-c5"><Stepper label="Port" value={c.port} onChange={(port) => up({ port })} /></div>

      <Lbl className="ds-c1">Username</Lbl>
      <input className="ds-field ds-c2" value={c.user ?? ''} placeholder="default" onChange={(e) => up({ user: e.target.value })} />
      <Lbl className="ds-c4">Password</Lbl>
      <input className="ds-field ds-c5" type="password" placeholder={passwordPlaceholder} value={c.password ?? ''} onChange={(e) => up({ password: e.target.value })} />

      <Lbl className="ds-c1">Database</Lbl>
      <input className="ds-field ds-c2" type="number" min={0} placeholder="0" value={c.database ?? ''} onChange={(e) => up({ database: e.target.value })} />

      <div className="ds-row-full">
        <Lbl style={{ width: 190 }}>SSL</Lbl>
        <Switch label="SSL" checked={!!c.ssl} onChange={(ssl) => up({ ssl })} />
      </div>
      {features('Options', (
        <Fragment>
          <Check checked={!!c.readonly} onChange={(readonly) => up({ readonly })} label="Read-only" /><Lbl>Read-only</Lbl>
        </Fragment>
      ))}
    </Fragment>
  )

  /* --- Main tab: Elasticsearch (HTTP endpoint + optional basic auth) --- */
  const elasticFields = (
    <Fragment>
      <Lbl className="ds-c1" req>Host</Lbl>
      <input className="ds-field ds-c2" value={c.host ?? ''} placeholder="localhost" onChange={(e) => up({ host: e.target.value })} />
      <Lbl className="ds-c4" req>Port</Lbl>
      <div className="ds-c5"><Stepper label="Port" value={c.port} onChange={(port) => up({ port })} /></div>

      <Lbl className="ds-c1">Username</Lbl>
      <input className="ds-field ds-c2" value={c.user ?? ''} placeholder="elastic" onChange={(e) => up({ user: e.target.value })} />
      <Lbl className="ds-c4">Password</Lbl>
      <input className="ds-field ds-c5" type="password" placeholder={passwordPlaceholder} value={c.password ?? ''} onChange={(e) => up({ password: e.target.value })} />

      <div className="ds-row-full">
        <Lbl style={{ width: 190 }}>SSL</Lbl>
        <Switch label="SSL" checked={!!c.ssl} onChange={(ssl) => up({ ssl })} />
      </div>
      {features('Options', (
        <Fragment>
          <Check checked={!!c.readonly} onChange={(readonly) => up({ readonly })} label="Read-only" /><Lbl>Read-only</Lbl>
        </Fragment>
      ))}
    </Fragment>
  )

  /* --- Main tab: Cassandra native (contact point + data center + optional keyspace) --- */
  const cassandraFields = (
    <Fragment>
      <Lbl className="ds-c1" req>Host</Lbl>
      <input className="ds-field ds-c2" value={c.host ?? ''} placeholder="localhost" onChange={(e) => up({ host: e.target.value })} />
      <Lbl className="ds-c4" req>Port</Lbl>
      <div className="ds-c5"><Stepper label="Port" value={c.port} onChange={(port) => up({ port })} /></div>

      <Lbl className="ds-c1">Data center</Lbl>
      <input className="ds-field ds-c2" value={c.dataCenter ?? ''} placeholder="datacenter1" onChange={(e) => up({ dataCenter: e.target.value })} />
      <Lbl className="ds-c4">Keyspace</Lbl>
      <input className="ds-field ds-c5" placeholder="Optional" value={c.database ?? ''} onChange={(e) => up({ database: e.target.value })} />

      <Lbl className="ds-c1">Username</Lbl>
      <input className="ds-field ds-c2" value={c.user ?? ''} placeholder="cassandra" onChange={(e) => up({ user: e.target.value })} />
      <Lbl className="ds-c4">Password</Lbl>
      <input className="ds-field ds-c5" type="password" placeholder={passwordPlaceholder} value={c.password ?? ''} onChange={(e) => up({ password: e.target.value })} />

      <div className="ds-row-full">
        <Lbl style={{ width: 190 }}>SSL</Lbl>
        <Switch label="SSL" checked={!!c.ssl} onChange={(ssl) => up({ ssl })} />
      </div>
      {features('Options', (
        <Fragment>
          <Check checked={!!c.readonly} onChange={(readonly) => up({ readonly })} label="Read-only" /><Lbl>Read-only</Lbl>
        </Fragment>
      ))}
    </Fragment>
  )

  /* --- Main tab: S3 (endpoint optional; AWS by default) --- */
  const s3Fields = (
    <Fragment>
      <Lbl className="ds-c1">Endpoint</Lbl>
      <input className="ds-field ds-c2" value={c.host ?? ''} placeholder="s3.amazonaws.com (blank = AWS)" onChange={(e) => up({ host: e.target.value })} />
      <Lbl className="ds-c4">Port</Lbl>
      <div className="ds-c5"><Stepper label="Port" value={c.port} onChange={(port) => up({ port })} /></div>

      <Lbl className="ds-c1">Region</Lbl>
      <input className="ds-field ds-c2" value={c.region ?? ''} placeholder="us-east-1" onChange={(e) => up({ region: e.target.value })} />

      <Lbl className="ds-c1">Access key ID</Lbl>
      <input className="ds-field ds-c2" value={c.user ?? ''} placeholder="Access key ID (blank = default chain)" onChange={(e) => up({ user: e.target.value })} />
      <Lbl className="ds-c4">Secret key</Lbl>
      <input className="ds-field ds-c5" type="password" placeholder="Secret access key" value={c.password ?? ''} onChange={(e) => up({ password: e.target.value })} />

      <div className="ds-row-full">
        <Lbl style={{ width: 190 }}>SSL</Lbl>
        <Switch label="SSL" checked={!!c.ssl} onChange={(ssl) => up({ ssl })} />
      </div>
      {features('Options', (
        <Fragment>
          <Check checked={!!c.readonly} onChange={(readonly) => up({ readonly })} label="Read-only" /><Lbl>Read-only</Lbl>
        </Fragment>
      ))}
    </Fragment>
  )

  /* --- Main tab: FTP / FTPS (explicit AUTH TLS only) --- */
  const ftpFields = (
    <Fragment>
      <Lbl className="ds-c1" req>Host</Lbl>
      <input className="ds-field ds-c2" value={c.host ?? ''} placeholder="localhost" onChange={(e) => up({ host: e.target.value })} />
      <Lbl className="ds-c4" req>Port</Lbl>
      <div className="ds-c5"><Stepper label="Port" value={c.port} onChange={(port) => up({ port })} /></div>

      <Lbl className="ds-c1">Username</Lbl>
      <input className="ds-field ds-c2" value={c.user ?? ''} placeholder="anonymous" onChange={(e) => up({ user: e.target.value })} />
      <Lbl className="ds-c4">Password</Lbl>
      <input className="ds-field ds-c5" type="password" placeholder={passwordPlaceholder} value={c.password ?? ''} onChange={(e) => up({ password: e.target.value })} />

      <div className="ds-row-full">
        <Lbl style={{ width: 190 }}>FTPS (AUTH TLS)</Lbl>
        <Switch label="FTPS" checked={!!c.ssl} onChange={(ssl) => up({ ssl })} />
      </div>
      {features('Options', (
        <Fragment>
          <Check checked={!!c.readonly} onChange={(readonly) => up({ readonly })} label="Read-only" /><Lbl>Read-only</Lbl>
        </Fragment>
      ))}
    </Fragment>
  )

  /* --- Main tab: Kafka (bootstrap brokers; SASL/PLAIN optional) --- */
  const kafkaFields = (
    <Fragment>
      <Lbl className="ds-c1" req>Brokers</Lbl>
      <input className="ds-field ds-c2" value={c.host ?? ''} placeholder="localhost, broker2:9092" onChange={(e) => up({ host: e.target.value })} />
      <Lbl className="ds-c4" req>Port</Lbl>
      <div className="ds-c5"><Stepper label="Port" value={c.port} onChange={(port) => up({ port })} /></div>

      <Lbl className="ds-c1">Username</Lbl>
      <input className="ds-field ds-c2" value={c.user ?? ''} placeholder="Optional (SASL/PLAIN)" onChange={(e) => up({ user: e.target.value })} />
      <Lbl className="ds-c4">Password</Lbl>
      <input className="ds-field ds-c5" type="password" placeholder="SASL/PLAIN password" value={c.password ?? ''} onChange={(e) => up({ password: e.target.value })} />

      <div className="ds-row-full">
        <Lbl style={{ width: 190 }}>SSL</Lbl>
        <Switch label="SSL" checked={!!c.ssl} onChange={(ssl) => up({ ssl })} />
      </div>
      {features('Options', (
        <Fragment>
          <Check checked={!!c.readonly} onChange={(readonly) => up({ readonly })} label="Read-only" /><Lbl>Read-only</Lbl>
        </Fragment>
      ))}
    </Fragment>
  )

  /* --- Main tab: RabbitMQ (Management HTTP API; 15672 by default) --- */
  const rabbitmqFields = (
    <Fragment>
      <Lbl className="ds-c1" req>Host</Lbl>
      <input className="ds-field ds-c2" value={c.host ?? ''} placeholder="localhost (management API)" onChange={(e) => up({ host: e.target.value })} />
      <Lbl className="ds-c4" req>Port</Lbl>
      <div className="ds-c5"><Stepper label="Port" value={c.port} onChange={(port) => up({ port })} /></div>

      <Lbl className="ds-c1">Username</Lbl>
      <input className="ds-field ds-c2" value={c.user ?? ''} placeholder="guest" onChange={(e) => up({ user: e.target.value })} />
      <Lbl className="ds-c4">Password</Lbl>
      <input className="ds-field ds-c5" type="password" placeholder={passwordPlaceholder} value={c.password ?? ''} onChange={(e) => up({ password: e.target.value })} />

      <div className="ds-row-full">
        <Lbl style={{ width: 190 }}>SSL</Lbl>
        <Switch label="SSL" checked={!!c.ssl} onChange={(ssl) => up({ ssl })} />
      </div>
      {features('Options', (
        <Fragment>
          <Check checked={!!c.readonly} onChange={(readonly) => up({ readonly })} label="Read-only" /><Lbl>Read-only</Lbl>
        </Fragment>
      ))}
    </Fragment>
  )

  /* --- Main tab: file databases --- */
  const sqliteFields = (
    <Fragment>
      <Lbl className="ds-c1" req>File</Lbl>
      <div className="ds-with-btn ds-c2">
        <input className="ds-field" value={c.filePath ?? ''} placeholder="path/to/database.db  (or :memory:)" onChange={(e) => up({ filePath: e.target.value })} />
        <button className="ds-btn ds-icon-btn" type="button" aria-label="Browse database file" title="Choose file" onClick={() => void pick((f) => up({ filePath: f }), ['db', 'sqlite', 'sqlite3', 'db3'])}>…</button>
      </div>
      {features('Options', (
        <Fragment>
          <Check checked={!!c.readonly} onChange={(readonly) => up({ readonly })} label="Read-only" /><Lbl>Read-only</Lbl>
        </Fragment>
      ))}
    </Fragment>
  )

  /* --- Main tab: JDBC sidecar --- */
  const jdbcFields = (
    <Fragment>
      <Lbl className="ds-c1" req>JDBC URL</Lbl>
      <input className="ds-field ds-wide" placeholder="jdbc:oracle:thin:@//host:1521/service" value={c.jdbc?.url ?? ''} onChange={(e) => up({ jdbc: { url: e.target.value, driverPath: c.jdbc?.driverPath ?? '', driverClass: c.jdbc?.driverClass, dialect: c.jdbc?.dialect ?? 'generic' } })} />

      <Lbl className="ds-c1" req>Driver file</Lbl>
      <div className="ds-with-btn ds-c2">
        <input className="ds-field" value={c.jdbc?.driverPath ?? ''} placeholder="ojdbc11.jar (file, folder or archive)" onChange={(e) => up({ jdbc: { url: c.jdbc?.url ?? '', driverPath: e.target.value, driverClass: c.jdbc?.driverClass, dialect: c.jdbc?.dialect ?? 'generic' } })} />
        <button className="ds-btn ds-icon-btn" type="button" aria-label="Browse driver file" title="Choose driver" onClick={() => void pick((f) => up({ jdbc: { url: c.jdbc?.url ?? '', driverPath: f, driverClass: c.jdbc?.driverClass, dialect: c.jdbc?.dialect ?? 'generic' } }), ['jar', 'zip'])}>…</button>
      </div>
      <Lbl className="ds-c4">Driver class</Lbl>
      <input className="ds-field ds-c5" placeholder="optional" value={c.jdbc?.driverClass ?? ''} onChange={(e) => up({ jdbc: { url: c.jdbc?.url ?? '', driverPath: c.jdbc?.driverPath ?? '', driverClass: e.target.value, dialect: c.jdbc?.dialect ?? 'generic' } })} />

      <Lbl className="ds-c1">SQL dialect</Lbl>
      <select className="ds-field ds-c2" value={c.jdbc?.dialect ?? 'generic'} onChange={(e) => up({ jdbc: { url: c.jdbc?.url ?? '', driverPath: c.jdbc?.driverPath ?? '', driverClass: c.jdbc?.driverClass, dialect: e.target.value as DialectId } })}>
        {DIALECTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
      </select>
      <Lbl className="ds-c4">Username</Lbl>
      <input className="ds-field ds-c5" value={c.user ?? ''} onChange={(e) => up({ user: e.target.value })} />

      <Lbl className="ds-c1">Password</Lbl>
      <input className="ds-field ds-c2" type="password" placeholder={passwordPlaceholder} value={c.password ?? ''} onChange={(e) => up({ password: e.target.value })} />

      {features('Options', (
        <Fragment>
          <Check checked={!!c.readonly} onChange={(readonly) => up({ readonly })} label="Read-only" /><Lbl>Read-only</Lbl>
        </Fragment>
      ))}
    </Fragment>
  )

  /* --- SSH connection helper (real: main opens the tunnel before the transport) --- */
  const setSsh = (p: Partial<SshConfig>) => up({ ssh: { ...sshCfg, ...p } })
  const sshFields = sql ? (
    <p className="ds-note">SQLite opens local files; an SSH tunnel does not apply. Pick a network server type to use this helper.</p>
  ) : (
    <Fragment>
      <Lbl className="ds-c1">Enable</Lbl>
      <div className="ds-c2 ds-start"><Switch label="Enable SSH tunnel" checked={sshOn} onChange={(enabled) => setSsh({ enabled })} /></div>

      <Lbl className="ds-c1" req dim={!sshOn}>Host</Lbl>
      <input className="ds-field ds-c2" value={sshCfg.host ?? ''} placeholder="jump host" disabled={!sshOn} onChange={(e) => setSsh({ host: e.target.value })} />
      <Lbl className="ds-c4" req dim={!sshOn}>Port</Lbl>
      <div className="ds-c5"><Stepper label="SSH port" value={sshCfg.port ?? 22} disabled={!sshOn} onChange={(port) => setSsh({ port })} /></div>

      <Lbl className="ds-c1" req dim={!sshOn}>Username</Lbl>
      <input className="ds-field ds-c2" value={sshCfg.user ?? ''} placeholder="root" disabled={!sshOn} onChange={(e) => setSsh({ user: e.target.value })} />
      <Lbl className="ds-c4" dim={!sshOn}>Connect Timeout(ms)</Lbl>
      <input className="ds-field ds-c5" type="number" min={0} value={sshCfg.connectTimeoutMs ?? 10000} disabled={!sshOn} onChange={(e) => setSsh({ connectTimeoutMs: Number(e.target.value) || undefined })} />

      <Lbl className="ds-c1" req dim={!sshOn}>Auth</Lbl>
      <div className="ds-c2 ds-start">
        <Seg tight value={sshAuth} onChange={(v) => setSsh({ authType: v as SshConfig['authType'] })} options={[
          { id: 'auto', label: 'Auto', disabled: !sshOn },
          { id: 'password', label: 'Password', disabled: !sshOn },
          { id: 'privateKey', label: 'Key', disabled: !sshOn },
          { id: 'agent', label: 'Agent', disabled: !sshOn },
        ]} />
      </div>
      <Lbl className="ds-c4" req={sshAuth === 'password'} dim={!sshOn}>Password</Lbl>
      <input className="ds-field ds-c5" type="password" placeholder={sshPasswordPlaceholder} value={sshCfg.password ?? ''} disabled={!sshOn} onChange={(e) => setSsh({ password: e.target.value })} />

      <Lbl className="ds-c1" req={sshAuth === 'privateKey'} dim={!sshOn}>Private Key Path</Lbl>
      <div className="ds-with-btn ds-c2">
        <input className="ds-field" value={sshCfg.privateKeyPath ?? ''} placeholder="~/.ssh/id_rsa" disabled={!sshOn} onChange={(e) => setSsh({ privateKeyPath: e.target.value })} />
        <button className="ds-btn ds-icon-btn" type="button" disabled={!sshOn} aria-label="Browse private key" title="Choose private key" onClick={() => void pick((f) => setSsh({ privateKeyPath: f }))}>…</button>
      </div>
      <Lbl className="ds-c4" dim={!sshOn}>Passphrase</Lbl>
      <input className="ds-field ds-c5" type="password" placeholder={passphrasePlaceholder} value={sshCfg.passphrase ?? ''} disabled={!sshOn} onChange={(e) => setSsh({ passphrase: e.target.value })} />

      <div className="ds-row-full">
        <p className="ds-note">The tunnel binds a random local port and forwards it to {c.kind === 'jdbc' ? 'the JDBC URL host' : c.kind === 'mongodb' && uriSet ? 'the connection string host' : `${c.host || 'the server'}${c.port ? `:${c.port}` : ''}`}.<br />
          Host keys are accepted as presented in this build — verify your SSH host independently.</p>
      </div>
    </Fragment>
  )

  const proxy = (label: string, port: number) => (
    <Fragment>
      <Lbl className="ds-c1">Enable</Lbl>
      <div className="ds-c2 ds-start"><span className="ds-badge-host"><Switch label={`Enable ${label}`} checked={false} disabled onChange={() => undefined} /><Premium /></span></div>

      <Lbl className="ds-c1" req dim>Host</Lbl>
      <input className="ds-field ds-c2" placeholder="Host" disabled />
      <Lbl className="ds-c4" req dim>Port</Lbl>
      <div className="ds-c5"><Stepper label={`${label} port`} value={port} disabled onChange={() => undefined} /></div>

      <Lbl className="ds-c1" dim>Username</Lbl>
      <input className="ds-field ds-c2" placeholder="Username" disabled />
      <Lbl className="ds-c4" dim>Password</Lbl>
      <input className="ds-field ds-c5" type="password" placeholder="Password" disabled />
    </Fragment>
  )

  /* --- Main tab: Docker helper (read-only container/port picker) --- */
  const docker = dockerHelper
  const dockerHost = docker?.mode === 'tcp' ? docker.host.trim() || '127.0.0.1' : '127.0.0.1'
  const dockerFields = docker && (
    <Fragment>
      <Lbl className="ds-c1">Daemon</Lbl>
      <div className="ds-wide ds-docker-actions">
        <Seg tight value={docker.mode} onChange={(mode) => patchDocker({ mode: mode === 'tcp' ? 'tcp' : 'socket', containers: undefined, scanned: false, error: undefined })} options={[{ id: 'socket', label: 'Unix socket' }, { id: 'tcp', label: 'TCP' }]} />
        <button className="ds-btn ds-btn-sm" type="button" disabled={docker.busy} onClick={() => void scanDocker(dockerHelper)}>{docker.busy ? 'Scanning…' : 'Scan containers'}</button>
        <span className="ds-lbl">read-only</span>
      </div>

      {docker.mode === 'socket' ? (
        <Fragment>
          <Lbl className="ds-c1">Socket</Lbl>
          <input className="ds-field ds-wide" value={docker.socketPath} placeholder="/var/run/docker.sock" onChange={(e) => patchDocker({ socketPath: e.target.value })} />
        </Fragment>
      ) : (
        <Fragment>
          <Lbl className="ds-c1">Host</Lbl>
          <input className="ds-field ds-c2" value={docker.host} placeholder="127.0.0.1" onChange={(e) => patchDocker({ host: e.target.value })} />
          <Lbl className="ds-c4">Port</Lbl>
          <div className="ds-c5"><Stepper label="Docker port" value={docker.port} onChange={(port) => patchDocker({ port })} /></div>
          <div className="ds-row-full">
            <Lbl style={{ width: 190 }}>TLS</Lbl>
            <Switch label="Docker TLS" checked={docker.ssl} onChange={(ssl) => patchDocker({ ssl })} />
          </div>
        </Fragment>
      )}

      <div className="ds-docker-box">
        <div className="ds-docker-head">
          <span>{docker.busy ? 'Looking for containers…' : docker.error ? 'Daemon unreachable' : docker.containers ? `${docker.containers.length} running container${docker.containers.length === 1 ? '' : 's'}` : 'Containers'}</span>
          <span className="ds-lbl">Pick a published TCP port to fill Host/Port</span>
        </div>
        {docker.error ? (
          <div className="ds-docker-empty ds-docker-error" role="alert">{docker.error}</div>
        ) : !docker.containers ? (
          <div className="ds-docker-empty">{docker.busy ? 'Contacting the Docker daemon…' : docker.scanned ? 'No running containers found.' : 'Scan to list running containers.'}</div>
        ) : docker.containers.length === 0 ? (
          <div className="ds-docker-empty">No running containers found. Start one and scan again.</div>
        ) : (
          <div className="ds-docker-scroll">
            {docker.containers.map((container) => {
              const guess = inferDockerKind(container.image)
              const ports = publishedPorts(container)
              return (
                <div className="ds-docker-row" key={container.id}>
                  <div className="ds-docker-name" title={container.id}>
                    {container.name}
                    <span className="ds-docker-image">{container.image}</span>
                  </div>
                  <div className="ds-docker-state" title={container.status}>{container.status}</div>
                  <div className="ds-docker-ports">
                    {guess && <span className="ds-docker-guess" title={`The image looks like ${guess.label}`}>{guess.label}</span>}
                    {ports.length === 0 ? (
                      <span className="ds-lbl">no published TCP ports</span>
                    ) : (
                      ports.map((port) => (
                        <button
                          key={`${port.privatePort}-${port.publicPort}-${port.ip ?? ''}`}
                          className={`ds-btn ds-btn-sm ds-docker-port${guess?.privatePort === port.privatePort ? ' rec' : ''}`}
                          type="button"
                          title={`Use ${dockerHost}:${port.publicPort} (container port ${port.privatePort})`}
                          onClick={() => useDockerPort(container, port)}
                        >
                          {port.publicPort} → {port.privatePort}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
      {sshOn && <div className="ds-row-full ds-docker-warn"><Icon id="info" />The SSH tunnel is on: turn it off to use a published local port.</div>}
    </Fragment>
  )

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && set({ dialog: null })}>
      <section className="ds-modal" role="dialog" aria-label="Connect to server">
        <header className="ds-head">
          <DbLogo />
          <h1>Connect to server</h1>
        </header>

        <div className="ds-body">
          <div className="ds-toprow">
            <div className="ds-pair">
              <Lbl>Name</Lbl>
              <input className="ds-field ds-w-name" placeholder="Connection Name" aria-label="Name" autoFocus value={c.name} onChange={(e) => up({ name: e.target.value })} />
            </div>
            <div className="ds-pair">
              <Lbl req>Group</Lbl>
              <input className="ds-field ds-w-group" placeholder="Parent/Sub" aria-label="Group" value={c.group ?? ''} onChange={(e) => up({ group: e.target.value })} />
            </div>
            {/* <button className="ds-btn" type="button" onClick={() => soon('Advanced options')}><Icon id="settings-gear" />Advanced_1</button>
            <div className="ds-pair">
              <Lbl req>Scope</Lbl>
              <Seg value={draft.scope} onChange={(scope) => d({ scope })} options={[
                { id: 'global', label: 'Global' },
                { id: 'workspace', label: 'Workspace', disabled: true, premium: true },
              ]} />
            </div> */}
          </div>

          {/* <p className="ds-note">Note: Requires a <button type="button" className="ds-link" onClick={() => soon('Premium licensing')}>Premium License</button> to unlock all features. Database 0/3 , Other 0/3</p>
          <hr className="ds-rule" /> */}

          <div className="ds-sec">Server Type</div>
          <div className="ds-st-rows" role="tablist" aria-label="Server Type">{typeRow(ROW1)}{typeRow(ROW2)}</div>

          <div className="ds-cfg">
            <span className="ds-sec">Config</span>
            <div className="ds-tabs" role="tablist" aria-label="Config">
              <button type="button" role="tab" aria-selected={tab === 'main'} className={`ds-tab${tab === 'main' ? ' on' : ''}`} onClick={() => goTab('main')}><Icon id="settings-gear" />Main</button>
              <button type="button" role="tab" aria-selected={tab === 'ssh'} className={`ds-tab${tab === 'ssh' ? ' on' : ''}`} onClick={() => goTab('ssh')}><Icon id="terminal" />SSH Tunnel</button>
              <button type="button" role="tab" aria-selected={tab === 'socks'} className={`ds-tab${tab === 'socks' ? ' on' : ''}`} onClick={() => goTab('socks')}><DbIcon name="socks" size={18} />Socks Proxy</button>
              <button type="button" role="tab" aria-selected={tab === 'http'} className={`ds-tab${tab === 'http' ? ' on' : ''}`} onClick={() => goTab('http')}><DbIcon name="http" size={18} />HTTP Proxy</button>
            </div>
          </div>

          {tab === 'main' && <section className="ds-pane" role="tabpanel" aria-label="Main">{dockerFields ?? (sql ? sqliteFields : c.kind === 'jdbc' ? jdbcFields : c.kind === 'mongodb' ? mongoFields : c.kind === 'redis' ? redisFields : c.kind === 'elastic' ? elasticFields : c.kind === 'cassandra' ? cassandraFields : c.kind === 's3' ? s3Fields : c.kind === 'ftp' ? ftpFields : c.kind === 'kafka' ? kafkaFields : c.kind === 'rabbitmq' ? rabbitmqFields : netFields)}</section>}
          {tab === 'ssh' && <section className="ds-pane" role="tabpanel" aria-label="SSH Tunnel">{sshFields}</section>}
          {tab === 'socks' && <section className="ds-pane" role="tabpanel" aria-label="Socks Proxy">{proxy('Socks proxy', 1080)}</section>}
          {tab === 'http' && <section className="ds-pane" role="tabpanel" aria-label="HTTP Proxy">{proxy('HTTP proxy', 3128)}</section>}
        </div>

        <footer className="ds-foot">
          <div className="ds-foot-row">
            <button className="ds-btn ds-btn-neutral" type="button" disabled={!ok || busy || !!dockerHelper} onClick={() => void doTest()}>{busy ? 'Testing…' : 'Test Connection'}</button>
            <div className="ds-foot-actions">
              <button className="ds-btn" type="button" disabled={!ok || !!dockerHelper} onClick={() => void save(false)}><DbIcon name="save" size={15} />Save</button>
              <button className="ds-btn" type="button" disabled={!ok || !!dockerHelper} onClick={() => void save(true)}><Icon id="add" />Connect</button>
              <button className="ds-btn ds-btn-neutral" type="button" onClick={() => set({ dialog: null })}><Icon id="close" />Close</button>
            </div>
            <span className="ds-foot-slot" />
          </div>
          <div className={`ds-status${note ? (note.tone === 'ok' ? ' ok' : note.tone === 'bad' ? ' bad' : '') : ''}`} role="status" aria-live="polite">
            {note?.tone === 'ok' && <Icon id="pass" />}
            {note?.tone === 'bad' && <Icon id="error" />}
            {note?.tone === 'info' && <Icon id="info" />}
            {note ? note.text : hint}
          </div>
        </footer>
      </section>
    </div>
  )
}
