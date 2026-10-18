import { z } from 'zod'

const port = z.number().int().min(1).max(65535)
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
  ssh: ssh.optional(),
  readonly: z.boolean().optional(),
  group: z.string().max(500).optional(),
}).passthrough()

export const idSchema = z.string().min(1).max(200)
export const sqlSchema = z.string().max(10_000_000)
export const queryOptionsSchema = z.object({
  limit: z.number().int().min(1).max(100_000).optional(),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().optional()
export const statementsSchema = z.array(sqlSchema).max(10_000)
export const settingsPatchSchema = z.record(z.string(), z.unknown())
export const saveFilterSchema = z.object({ name: z.string(), extensions: z.array(z.string()) })
export const filtersSchema = z.array(saveFilterSchema).optional()
export const dockerEndpointSchema = z.object({
  socketPath: z.string().max(4000).optional(),
  host: z.string().max(2000).optional(),
  port: port.optional(),
  ssl: z.boolean().optional(),
}).strict()
export const themePathSchema = z.string().min(1).max(4000)
export const exportSizeSchema = z.object({
  width: z.number().finite().min(1).max(100_000),
  height: z.number().finite().min(1).max(100_000),
})
