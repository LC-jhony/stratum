import { ListBucketsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import type { ListObjectsV2CommandOutput } from '@aws-sdk/client-s3'
import type { ColumnMeta, ConnectionConfig, RawResult, SchemaInfo, TableInfo } from '../../../shared/types'
import type { Transport } from '../types'

/**
 * S3 transport (read-only MVP).
 *
 * There is no query console: the Explorer lists buckets as schemas and every bucket exposes one
 * `objects` table whose rows are the bucket root listing (`ListObjectsV2` with a `/` delimiter, so
 * common prefixes arrive as folder rows). Opening the table runs the paged reader
 * `LIST "<bucket>" <offset> <limit>`, which walks continuation tokens from the start (S3 has no
 * offset), bounded by `MAX_WALK`. Nothing is ever written and no other statement kind reaches the
 * service.
 *
 * Configuration: an empty endpoint means AWS S3 (SDK default endpoint, always HTTPS); a host means
 * an S3-compatible endpoint (`http`/`https` by the SSL switch) with path-style addressing, which is
 * what MinIO, R2 and friends expect. Credentials are optional: without them the SDK's default
 * provider chain (environment, profile, instance role) is used.
 */

const DEFAULT_PORT = 443
const MAX_BUCKETS = 100
const MAX_WALK = 10000
/** ListObjectsV2 returns at most 1000 keys per call. */
const PAGE_KEYS = 1000

export const OBJECT_COLUMNS: ColumnMeta[] = [
  { name: 'key' },
  { name: 'kind' },
  { name: 'size' },
  { name: 'lastModified' },
  { name: 'storageClass' },
]

export interface S3ClientLike {
  send(command: unknown): Promise<unknown>
}
export type S3ClientFactory = (cfg: ConnectionConfig) => S3ClientLike

export function createS3Client(cfg: ConnectionConfig): S3ClientLike {
  const host = cfg.host?.trim()
  const port = cfg.port && cfg.port > 0 ? cfg.port : undefined
  const endpoint = host ? `${cfg.ssl ? 'https' : 'http'}://${host}${port ? `:${port}` : ''}` : undefined
  return new S3Client({
    region: cfg.region?.trim() || 'us-east-1',
    endpoint,
    forcePathStyle: !!endpoint,
    credentials: cfg.user?.trim() ? { accessKeyId: cfg.user.trim(), secretAccessKey: cfg.password ?? '' } : undefined,
    maxAttempts: 2,
  })
}

export interface S3List {
  bucket: string
  offset: number
  limit: number
}

const LIST_STATEMENT = /^LIST[ \t]+("(?:[^"\\]|\\.)*"|\S+)(?:[ \t]+(\d+))?(?:[ \t]+(\d+))?[ \t]*;?[ \t]*$/i

/** `LIST "<bucket>" [offset] [limit]` — the only statement this transport executes. */
export function parseS3List(stmt: string): S3List | undefined {
  const m = LIST_STATEMENT.exec(stmt.trim())
  if (!m) return undefined
  let bucket = m[1]
  if (bucket.startsWith('"')) {
    try { bucket = String(JSON.parse(bucket)) } catch { /* keep the raw token */ }
  }
  return { bucket, offset: Number(m[2] ?? 0) || 0, limit: Number(m[3] ?? 500) || 500 }
}

export function isS3Read(stmt: string): boolean {
  return parseS3List(stmt) !== undefined
}

/** S3 listings page by continuation token, so the offset/limit travel in the internal statement. */
export function paginateS3Statement(stmt: string, limit: number, offset: number): string | undefined {
  const list = parseS3List(stmt)
  return list ? `LIST ${JSON.stringify(list.bucket)} ${offset} ${limit}` : undefined
}

export class S3Transport implements Transport {
  private client: S3ClientLike

  constructor(private cfg: ConnectionConfig, make: S3ClientFactory = createS3Client) {
    this.client = make(cfg)
  }

  async open(): Promise<{ version?: string }> {
    try {
      await this.client.send(new ListBucketsCommand({}))
    } catch (e) {
      throw new Error(`S3 connection to ${this.target()} failed: ${msg(e)}`)
    }
    return {} // S3 exposes no server version
  }

  async query(stmt: string): Promise<RawResult> {
    const list = parseS3List(stmt)
    if (!list) throw new Error('S3 has no query console in this build: open a bucket in the Explorer to list its objects.')
    return this.listObjects(list.bucket, list.offset, list.limit)
  }

  async cancel(): Promise<void> { /* ListObjectsV2 requests are short-lived; close stays explicit */ }

  async close(): Promise<void> { /* the SDK client holds keep-alive sockets; the process drops them on exit */ }

  async introspectModel(): Promise<{ schemas: SchemaInfo[] }> {
    const res = (await this.client.send(new ListBucketsCommand({}))) as { Buckets?: { Name?: string }[] }
    const names = (res.Buckets ?? [])
      .map((b) => String(b.Name ?? ''))
      .filter(Boolean)
      .sort()
      .slice(0, MAX_BUCKETS)
    return { schemas: names.map((name) => ({ name, tables: [objectsTable()] })) }
  }

  private async listObjects(bucket: string, offset: number, limit: number): Promise<RawResult> {
    const target = Math.min(Math.max(1, offset + limit), MAX_WALK)
    const rows: unknown[][] = []
    let token: string | undefined
    while (rows.length < target) {
      const input = { Bucket: bucket, Delimiter: '/', MaxKeys: PAGE_KEYS, ContinuationToken: token }
      const res = (await this.client.send(new ListObjectsV2Command(input))) as ListObjectsV2CommandOutput
      for (const object of res.Contents ?? []) {
        rows.push([object.Key ?? null, 'object', object.Size ?? null, object.LastModified ?? null, object.StorageClass ?? null])
      }
      for (const prefix of res.CommonPrefixes ?? []) {
        rows.push([prefix.Prefix ?? null, 'folder', null, null, null])
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined
      if (!token) break
    }
    return { columns: OBJECT_COLUMNS, rows: rows.slice(offset, offset + limit) }
  }

  private target(): string {
    const host = this.cfg.host?.trim()
    if (!host) return 's3.amazonaws.com (default endpoint)'
    const port = this.cfg.port && this.cfg.port > 0 ? this.cfg.port : DEFAULT_PORT
    return `${this.cfg.ssl ? 'https' : 'http'}://${host}:${port}`
  }
}

function objectsTable(): TableInfo {
  return {
    name: 'objects',
    kind: 'table',
    columns: OBJECT_COLUMNS.map((column, ordinal) => ({
      name: column.name,
      dataType: column.name === 'size' ? 'int64' : column.name === 'lastModified' ? 'timestamp' : 'string',
      nullable: column.name !== 'key',
      isPrimaryKey: false,
      ordinal,
    })),
    foreignKeys: [],
    indexes: [],
  }
}

function msg(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause
    return cause instanceof Error ? `${e.message} (${cause.message})` : e.message
  }
  return String(e)
}
