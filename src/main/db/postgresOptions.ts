import type { ClientConfig } from 'pg'
import type { ConnectionConfig } from '../../shared/types'
import { sslMaterial } from './ssl'

/** OIDs the UI can label without a catalog round trip (result columns). */
export const PG_TYPE_OIDS: Record<number, string> = {
  16: 'bool', 17: 'bytea', 18: 'char', 19: 'name', 20: 'int8', 21: 'int2', 23: 'int4', 24: 'regproc',
  25: 'text', 26: 'oid', 114: 'json', 142: 'xml', 600: 'point', 601: 'lseg', 602: 'path', 603: 'box',
  604: 'polygon', 628: 'line', 650: 'cidr', 700: 'float4', 701: 'float8', 705: 'unknown', 718: 'circle',
  790: 'money', 829: 'macaddr', 869: 'inet', 1042: 'bpchar', 1043: 'varchar', 1082: 'date', 1083: 'time',
  1114: 'timestamp', 1184: 'timestamptz', 1186: 'interval', 1266: 'timetz', 1700: 'numeric', 2950: 'uuid',
  3802: 'jsonb', 3904: 'int4range', 3906: 'numrange', 3908: 'tsrange', 3910: 'tstzrange', 3912: 'daterange',
}

export const pgTypeName = (oid: number): string => PG_TYPE_OIDS[oid] ?? `oid ${oid}`

/**
 * `pg` client options derived from a data source. Shared by the regular transport and the
 * debugger, so both honour the same TLS files, unix socket, timeout and credentials.
 */
export async function postgresClientOptions(cfg: ConnectionConfig): Promise<ClientConfig> {
  const tls = await sslMaterial(cfg)
  return {
    host: cfg.socketPath?.trim() || cfg.host || 'localhost',
    port: cfg.port ?? 5432,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    // Certificate verification is opt-in: existing profiles that only enable SSL keep working.
    ssl: cfg.ssl ? { rejectUnauthorized: cfg.sslVerify === true, ...tls } : undefined,
    connectionTimeoutMillis: cfg.session?.connectTimeoutMs ?? 10_000,
  }
}
