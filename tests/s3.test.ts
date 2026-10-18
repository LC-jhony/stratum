import { describe, expect, it } from 'vitest'
import { createSession } from '../src/main/db/factory'
import { createS3Dialect } from '../src/main/db/s3Dialect'
import { DbSession } from '../src/main/db/session'
import { S3Transport, isS3Read, paginateS3Statement, parseS3List, type S3ClientLike } from '../src/main/db/transports/s3'
import { KINDS, isSqlKind } from '../src/shared/kinds'
import type { ConnectionConfig } from '../src/shared/types'

/**
 * S3 is an Explorer-only provider in this MVP (no console), so the pins here are the internal
 * `LIST` reader, its continuation-token paging, bucket introspection and the fact that nothing
 * else can reach the SDK. The fake inspects the real command objects, so wiring bugs in the
 * commands (bucket, delimiter, token) surface without a network.
 */

const cfg = (extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({ id: 's3', name: 's3', kind: 's3', region: 'us-east-1', ...extra })

type Entry = { kind: 'object' | 'folder'; key: string; size?: number }

class FakeS3 implements S3ClientLike {
  calls: { name: string; input: Record<string, unknown> }[] = []
  failBuckets = false
  readonly entries: Record<string, Entry[]> = {
    photos: [{ kind: 'folder', key: 'albums/' }, ...Array.from({ length: 2600 }, (_, i) => ({ kind: 'object' as const, key: `img-${String(i).padStart(4, '0')}.jpg`, size: 100 + i }))],
    backups: [
      { kind: 'object', key: 'db.tar.gz', size: 1024 },
      { kind: 'object', key: 'readme.txt', size: 12 },
      { kind: 'folder', key: 'logs/' },
    ],
  }

  async send(command: unknown): Promise<unknown> {
    const ctor = (command as { constructor: { name: string } }).constructor
    const input = ((command as { input?: Record<string, unknown> }).input ?? {}) as Record<string, unknown>
    this.calls.push({ name: ctor.name, input })
    if (ctor.name === 'ListBucketsCommand') {
      if (this.failBuckets) throw new Error('InvalidAccessKeyId')
      return { Buckets: [{ Name: 'photos' }, { Name: 'backups' }] }
    }
    if (ctor.name === 'ListObjectsV2Command') {
      const bucket = String(input.Bucket ?? '')
      if (bucket === 'forbidden') throw new Error('AccessDenied')
      const entries = this.entries[bucket] ?? []
      const start = Number(input.ContinuationToken ?? 0)
      const max = Number(input.MaxKeys ?? 1000)
      const page = entries.slice(start, start + max)
      const next = start + max < entries.length ? String(start + max) : undefined
      return {
        Contents: page.filter((e) => e.kind === 'object').map((e) => ({ Key: e.key, Size: e.size, LastModified: new Date('2026-10-01T10:00:00Z'), StorageClass: 'STANDARD' })),
        CommonPrefixes: page.filter((e) => e.kind === 'folder').map((e) => ({ Prefix: e.key })),
        IsTruncated: !!next,
        NextContinuationToken: next,
      }
    }
    throw new Error(`unexpected command ${ctor.name}`)
  }
}

const make = (extra: Partial<ConnectionConfig> = {}) => {
  const fake = new FakeS3()
  const transport = new S3Transport(cfg(extra), () => fake)
  return { fake, transport, session: new DbSession(cfg(extra), transport, createS3Dialect(transport)) }
}

describe('s3 statements', () => {
  it('parses the internal LIST reader and rewrites it for paging', () => {
    expect(parseS3List('LIST "photos"')).toEqual({ bucket: 'photos', offset: 0, limit: 500 })
    expect(parseS3List('list photos 10 5')).toEqual({ bucket: 'photos', offset: 10, limit: 5 })
    expect(parseS3List('LIST "a\\"b" 0 2')).toEqual({ bucket: 'a"b', offset: 0, limit: 2 })
    expect(paginateS3Statement('LIST "photos"', 501, 1000)).toBe('LIST "photos" 1000 501')
    expect(paginateS3Statement('SELECT 1', 501, 0)).toBeUndefined()
    expect(isS3Read('LIST "photos"')).toBe(true)
    expect(isS3Read('GET /photos')).toBe(false)
  })
})

describe('s3 transport', () => {
  it('validates credentials with ListBuckets and reports the target', async () => {
    const { transport } = make()
    expect(await transport.open()).toEqual({})

    const denied = new FakeS3()
    denied.failBuckets = true
    const broken = new S3Transport(cfg(), () => denied)
    await expect(broken.open()).rejects.toThrow(/S3 connection to s3\.amazonaws\.com \(default endpoint\) failed: InvalidAccessKeyId/)

    const custom = new S3Transport(cfg({ host: 'minio.local', port: 9000 }), () => denied)
    await expect(custom.open()).rejects.toThrow(/S3 connection to http:\/\/minio\.local:9000 failed/)
  })

  it('introspects buckets as schemas with one objects table each', async () => {
    const { session } = make()
    const m = await session.introspect()
    expect(m.kind).toBe('s3')
    expect(isSqlKind('s3')).toBe(false)
    expect(KINDS.s3.defaultPort).toBe(443)
    expect(m.schemas.map((s) => s.name)).toEqual(['backups', 'photos'])
    for (const schema of m.schemas) {
      expect(schema.tables.map((t) => t.name)).toEqual(['objects'])
      expect(schema.tables[0].columns.map((c) => c.name)).toEqual(['key', 'kind', 'size', 'lastModified', 'storageClass'])
    }
    expect(m.schemas[0].tables[0].columns.find((c) => c.name === 'size')!.dataType).toBe('int64')
  })

  it('lists objects and common prefixes as folder rows', async () => {
    const { session, fake } = make()
    const r = await session.execute('LIST "backups"', { limit: 5 })
    expect(r.error).toBeUndefined()
    expect(r.columns.map((c) => c.name)).toEqual(['key', 'kind', 'size', 'lastModified', 'storageClass'])
    expect(r.rows.map((row) => row.slice(0, 3))).toEqual([
      ['db.tar.gz', 'object', 1024],
      ['readme.txt', 'object', 12],
      ['logs/', 'folder', null],
    ])
    expect(typeof r.rows[0][3]).toBe('string') // Date normalized for the grid
    expect(fake.calls.at(-1)!.input).toMatchObject({ Bucket: 'backups', Delimiter: '/', MaxKeys: 1000 })
    expect(fake.calls.at(-1)!.input.ContinuationToken).toBeUndefined()
  })

  it('walks continuation tokens to satisfy offsets and caps the window', async () => {
    const { session, fake } = make()
    const first = await session.execute('LIST "photos"', { limit: 1002 })
    expect(first.error).toBeUndefined()
    expect(first.hasMore).toBe(true)
    expect(first.rows).toHaveLength(1002)
    const listing = fake.calls.filter((c) => c.name === 'ListObjectsV2Command')
    expect(listing).toHaveLength(2)
    expect(listing[1].input.ContinuationToken).toBe('1000')

    const before = fake.calls.length
    const deep = await session.execute('LIST "photos"', { limit: 5, offset: 1500 })
    expect(deep.error).toBeUndefined()
    expect(deep.rows).toHaveLength(5)
    expect(deep.rows[0][0]).toBe('img-1499.jpg') // rows 1000.. are page two; the folder row sits at 999
    expect(deep.hasMore).toBe(true)
    expect(fake.calls.length).toBe(before + 2)
  })

  it('refuses every console statement before touching the SDK', async () => {
    const { session, fake } = make()
    const before = fake.calls.length
    for (const stmt of ['SELECT * FROM photos', 'GET /photos', 'DELETE bucket', 'LIST "photos" extra junk']) {
      const r = await session.execute(stmt)
      expect(r.error, stmt).toMatch(/S3 has no query console/)
    }
    expect(fake.calls.length).toBe(before)
  })

  it('keeps LIST working on read-only sources and gates the rest', async () => {
    const { session } = make({ readonly: true })
    expect((await session.execute('LIST "backups"', { limit: 2 })).error).toBeUndefined()
    expect((await session.execute('SELECT 1')).error).toMatch(/Data source is read-only/)
  })

  it('maps SDK errors into the results pane', async () => {
    const { session } = make()
    expect((await session.execute('LIST "forbidden"')).error).toMatch(/AccessDenied/)
  })

  it('is registered in the factory with a generic dialect', () => {
    const s = createSession(cfg())
    expect(s.dialect.id).toBe('generic')
    expect(s.config.kind).toBe('s3')
  })
})
