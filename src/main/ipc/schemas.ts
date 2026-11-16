import { z } from 'zod'

const port = z.number().int().min(1).max(65535)
const jumpHost = z.object({
  id: z.string().min(1).max(200),
  host: z.string().min(1).max(2000),
  port: port.optional(),
  user: z.string().min(1).max(2000),
  authType: z.enum(['auto', 'password', 'privateKey', 'agent']).optional(),
  password: z.string().max(100_000).optional(),
  privateKeyPath: z.string().max(4000).optional(),
  passphrase: z.string().max(100_000).optional(),
}).passthrough()
const ssh = z.object({
  enabled: z.boolean(),
  host: z.string().optional(),
  port: port.optional(),
  user: z.string().optional(),
  authType: z.enum(['auto', 'password', 'privateKey', 'agent']).optional(),
  password: z.string().optional(),
  privateKeyPath: z.string().optional(),
  passphrase: z.string().optional(),
  connectTimeoutMs: z.number().int().min(1).max(120_000).optional(),
  /** DataGrip MAX_JUMP_SERVERS: up to five intermediate hosts, traversed in order. */
  jumpHosts: z.array(jumpHost).max(5).optional(),
}).passthrough()
const session = z.object({
  initSql: z.string().max(100_000).optional(),
  defaultSchema: z.string().max(2000).optional(),
  defaultCatalog: z.string().max(2000).optional(),
  autoCommit: z.boolean().optional(),
  isolation: z.enum(['default', 'read uncommitted', 'read committed', 'repeatable read', 'serializable']).optional(),
  keepAliveSeconds: z.number().int().min(0).max(86_400).optional(),
  idleTimeoutSeconds: z.number().int().min(0).max(604_800).optional(),
}).passthrough()

export const connectionSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(500),
  kind: z.enum(['postgres', 'mysql', 'sqlite', 'jdbc', 'mongodb', 'redis', 'elastic', 'cassandra', 's3', 'ftp', 'kafka', 'rabbitmq']),
  host: z.string().max(2000).optional(),
  port: port.optional(),
  user: z.string().max(2000).optional(),
  password: z.string().max(100_000).optional(),
  database: z.string().max(2000).optional(),
  ssl: z.boolean().optional(),
  sslVerify: z.boolean().optional(),
  sslCaPath: z.string().max(4000).optional(),
  sslClientCertPath: z.string().max(4000).optional(),
  sslClientKeyPath: z.string().max(4000).optional(),
  sslKeyPassphrase: z.string().max(100_000).optional(),
  profile: z.enum(['dev', 'test', 'prod']).optional(),
  color: z.enum(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray']).optional(),
  confirmWrites: z.boolean().optional(),
  session: session.optional(),
  dataCenter: z.string().max(200).optional(),
  region: z.string().max(200).optional(),
  socketPath: z.string().max(4000).optional(),
  filePath: z.string().max(4000).optional(),
  jdbc: z.object({
    url: z.string().min(1).max(20_000),
    driverClass: z.string().max(500).optional(),
    driverPath: z.string().max(4000),
    dialect: z.string().min(1).max(100),
  }).passthrough().optional(),
  uri: z.string().max(20_000).optional(),
  authSource: z.string().max(2000).optional(),
  /** SQL variables expanded before execution; connection values override the globals. */
  variables: z.record(z.string().min(1).max(200), z.string().max(100_000)).optional(),
  ssh: ssh.optional(),
  readonly: z.boolean().optional(),
  group: z.string().max(500).optional(),
}).passthrough()

export const idSchema = z.string().min(1).max(200)
export const savepointNameSchema = z.string().min(1).max(63)
export const sqlSchema = z.string().max(10_000_000)
export const queryOptionsSchema = z.object({
  limit: z.number().int().min(1).max(1_000_000).optional(),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  full: z.boolean().optional(),
}).strict().optional()
export const statementsSchema = z.array(sqlSchema).max(10_000)
export const sessionIdSchema = z.union([z.number().int().positive(), z.string().min(1).max(64)])
export const savedQuerySchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  sql: sqlSchema,
  connectionId: z.string().min(1).max(200).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict()
export const settingsPatchSchema = z.record(z.string(), z.unknown())
export const saveFilterSchema = z.object({ name: z.string(), extensions: z.array(z.string()) })
export const filtersSchema = z.array(saveFilterSchema).optional()
/** Path accepted by `@include`; the desktop service resolves and validates it. */
export const scriptPathSchema = z.string().min(1).max(4000)
export const dockerEndpointSchema = z.object({
  socketPath: z.string().max(4000).optional(),
  host: z.string().max(2000).optional(),
  port: port.optional(),
  ssl: z.boolean().optional(),
}).strict()
export const themePathSchema = z.string().min(1).max(4000)
/** Managed JDBC driver JAR; the service additionally checks that it lives in <userData>/drivers. */
export const driverPathSchema = z.string().min(1).max(4000)
export const menuPositionSchema = z.object({
  x: z.number().int().min(0).max(100_000),
  y: z.number().int().min(0).max(100_000),
}).strict()
export const exportSizeSchema = z.object({
  width: z.number().finite().min(1).max(100_000),
  height: z.number().finite().min(1).max(100_000),
})
