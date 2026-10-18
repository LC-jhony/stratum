import { FileInfo, FileType } from 'basic-ftp'
import { describe, expect, it } from 'vitest'
import { createFtpDialect } from '../src/main/db/ftpDialect'
import { createSession } from '../src/main/db/factory'
import { DbSession } from '../src/main/db/session'
import { FtpTransport, isFtpRead, paginateFtpStatement, parseFtpList, type FtpClientLike } from '../src/main/db/transports/ftp'
import { KINDS, isSqlKind } from '../src/core/kinds'
import type { ConnectionConfig } from '../src/shared/types'

/**
 * FTP is an Explorer-only provider (no console), so these pins cover the internal `LIST` reader,
 * directory introspection, row shaping (folders, permissions, dates) and the read-only gate. The
 * fake client uses the real `FileInfo` class so its getters behave exactly like basic-ftp's.
 */

const cfg = (extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({ id: 'ftp', name: 'ftp', kind: 'ftp', host: '127.0.0.1', ...extra })

function entry(name: string, opts: { dir?: boolean; link?: boolean; size?: number; perms?: { user: number; group: number; world: number } | false; modified?: boolean } = {}): FileInfo {
  const file = new FileInfo(name)
  file.type = opts.dir ? FileType.Directory : opts.link ? FileType.SymbolicLink : FileType.File
  file.size = opts.size ?? (opts.dir ? 0 : 42)
  if (opts.modified !== false) file.modifiedAt = new Date('2026-10-18T10:00:00Z')
  file.rawModifiedAt = 'Oct 18 10:00'
  if (opts.perms !== false) file.permissions = opts.perms ?? { user: 7, group: 5, world: 5 }
  return file
}

class FakeFtp implements FtpClientLike {
  accesses: { host: string; port: number; user: string; password: string; secure: boolean }[] = []
  listed: string[] = []
  closes = 0
  failAccess = false
  failPath?: string
  readonly dirs: Record<string, FileInfo[]> = {
    '/': [
      entry('incoming', { dir: true }),
      entry('outgoing', { dir: true }),
      entry('readme.md', { size: 42, perms: { user: 6, group: 4, world: 4 } }),
      entry('legacy.log', { size: 7, perms: false, modified: false }),
      entry('latest', { link: true, size: 9 }),
      entry('.env', { size: 12, perms: false }),
    ],
    '/incoming': [entry('a.txt', { size: 1 }), entry('nested', { dir: true })],
    '/outgoing': [],
  }

  async access(options: { host: string; port: number; user: string; password: string; secure: boolean }) {
    this.accesses.push(options)
    if (this.failAccess) throw new Error('530 Login incorrect')
    return { code: 230 }
  }

  async list(path = '/'): Promise<FileInfo[]> {
    this.listed.push(path)
    if (path === this.failPath) throw new Error('550 Permission denied')
    return this.dirs[path] ?? []
  }

  close() { this.closes++ }
}

const make = (extra: Partial<ConnectionConfig> = {}) => {
  const fake = new FakeFtp()
  const transport = new FtpTransport(cfg(extra), () => fake)
  return { fake, transport, session: new DbSession(cfg(extra), transport, createFtpDialect(transport)) }
}

describe('ftp statements', () => {
  it('parses LIST paths and rewrites them for paging', () => {
    expect(parseFtpList('LIST "/"')).toEqual({ path: '/', offset: 0, limit: 500 })
    expect(parseFtpList('list incoming 5 11')).toEqual({ path: '/incoming', offset: 5, limit: 11 })
    expect(parseFtpList('LIST "incoming/"')).toEqual({ path: '/incoming', offset: 0, limit: 500 })
    expect(parseFtpList('LIST "/a b/c" 0 2')).toEqual({ path: '/a b/c', offset: 0, limit: 2 })
    expect(paginateFtpStatement('LIST "/incoming"', 501, 1000)).toBe('LIST "/incoming" 1000 501')
    expect(paginateFtpStatement('SELECT 1', 501, 0)).toBeUndefined()
    expect(isFtpRead('LIST "/"')).toBe(true)
    expect(isFtpRead('GET /')).toBe(false)
  })
})

describe('ftp transport', () => {
  it('logs in (anonymous by default), lists the root and reports the target', async () => {
    const { transport, fake } = make()
    expect(await transport.open()).toEqual({})
    expect(fake.accesses[0]).toEqual({ host: '127.0.0.1', port: 21, user: 'anonymous', password: 'anonymous@', secure: false })
    expect(fake.listed).toEqual(['/'])

    const secured = make({ ssl: true, user: 'deploy', password: 's3cret' })
    await secured.transport.open()
    expect(secured.fake.accesses[0]).toMatchObject({ user: 'deploy', password: 's3cret', secure: true })

    const broken = new FakeFtp()
    broken.failAccess = true
    const denied = new FtpTransport(cfg(), () => broken)
    await expect(denied.open()).rejects.toThrow(/FTP connection to 127\.0\.0\.1:21 failed: 530 Login incorrect/)
  })

  it('introspects one files schema with root folders as tables', async () => {
    const { session } = make()
    const m = await session.introspect()
    expect(m.kind).toBe('ftp')
    expect(isSqlKind('ftp')).toBe(false)
    expect(KINDS.ftp.defaultPort).toBe(21)
    expect(m.schemas.map((s) => s.name)).toEqual(['files'])
    expect(m.schemas[0].tables.map((t) => t.name)).toEqual(['(root)', 'incoming', 'outgoing'])
    expect(m.schemas[0].tables[0].columns.map((c) => c.name)).toEqual(['name', 'type', 'size', 'modified', 'permissions'])
  })

  it('maps folders, files, links, dates and permissions into rows', async () => {
    const { session } = make()
    const r = await session.execute('LIST "/"', { limit: 10 })
    expect(r.error).toBeUndefined()
    expect(r.rows).toEqual([
      ['incoming', 'folder', null, '2026-10-18T10:00:00.000Z', 'rwxr-xr-x'],
      ['outgoing', 'folder', null, '2026-10-18T10:00:00.000Z', 'rwxr-xr-x'],
      ['readme.md', 'file', 42, '2026-10-18T10:00:00.000Z', 'rw-r--r--'],
      ['legacy.log', 'file', 7, 'Oct 18 10:00', null],
      ['latest', 'link', 9, '2026-10-18T10:00:00.000Z', 'rwxr-xr-x'],
      ['.env', 'file', 12, '2026-10-18T10:00:00.000Z', null],
    ])
  })

  it('lists a folder table and pages the window locally', async () => {
    const { session, fake } = make()
    const folder = await session.execute('LIST "/incoming"', { limit: 5 })
    expect(folder.rows.map((row) => row.slice(0, 2))).toEqual([['a.txt', 'file'], ['nested', 'folder']])
    expect(fake.listed).toContain('/incoming')

    const page = await session.execute('LIST "/"', { limit: 2, offset: 2 })
    expect(page.rows.map((row) => row[0])).toEqual(['readme.md', 'legacy.log'])
    expect(page.hasMore).toBe(true)
  })

  it('refuses every console statement before touching the client', async () => {
    const { session, fake } = make()
    const before = fake.listed.length
    for (const stmt of ['SELECT * FROM files', 'GET /', 'DELETE readme.md', 'LIST "/" extra junk']) {
      const r = await session.execute(stmt)
      expect(r.error, stmt).toMatch(/FTP has no query console/)
    }
    expect(fake.listed.length).toBe(before)
  })

  it('keeps LIST working on read-only sources and gates the rest', async () => {
    const { session } = make({ readonly: true })
    expect((await session.execute('LIST "/"', { limit: 2 })).error).toBeUndefined()
    expect((await session.execute('DELETE readme.md')).error).toMatch(/Data source is read-only/)
  })

  it('maps client errors into the results pane and closes cleanly', async () => {
    const { session, transport, fake } = make()
    fake.failPath = '/boom'
    expect((await session.execute('LIST "/boom"')).error).toMatch(/550 Permission denied/)
    await transport.close()
    expect(fake.closes).toBe(1)
  })

  it('is registered in the factory with a generic dialect', () => {
    const s = createSession(cfg())
    expect(s.dialect.id).toBe('generic')
    expect(s.config.kind).toBe('ftp')
  })
})
