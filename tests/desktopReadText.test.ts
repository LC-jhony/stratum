import { mkdtemp, mkdir, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const roots = vi.hoisted(() => ({ home: '', docs: '' }))
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => name === 'home' ? roots.home : name === 'documents' ? roots.docs : tmpdir(),
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
  },
  shell: { showItemInFolder: () => undefined, openPath: async () => '' },
  BrowserWindow: class {},
}))

const { DesktopService } = await import('../src/main/services/desktopService')

const base = await mkdtemp(path.join(tmpdir(), 'stratum-include-'))
let service: InstanceType<typeof DesktopService>

beforeEach(() => {
  roots.home = path.join(base, 'home')
  roots.docs = path.join(base, 'documents')
  service = new DesktopService(() => null)
})

afterAll(async () => { await rm(base, { recursive: true, force: true }) })

describe('DesktopService.readText (@include)', () => {
  it('reads an absolute path and strips the UTF-8 BOM', async () => {
    const file = path.join(base, 'absolute.sql')
    await writeFile(file, '\uFEFFselect 1;', 'utf8')
    expect(await service.readText(file)).toEqual({ path: file, name: 'absolute.sql', content: 'select 1;' })
  })

  it('resolves a relative path next to the including script', async () => {
    const dir = path.join(base, 'scripts')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'seed.sql'), 'insert into t values (1);', 'utf8')
    const result = await service.readText('seed.sql', path.join(dir, 'main.sql'))
    expect(result).toMatchObject({ name: 'seed.sql', content: 'insert into t values (1);' })
    expect(result.path).toBe(path.join(dir, 'seed.sql'))
  })

  it('falls back to Documents for a top-level console', async () => {
    await mkdir(roots.docs, { recursive: true })
    await writeFile(path.join(roots.docs, 'shared.sql'), 'select 2;', 'utf8')
    const result = await service.readText('shared.sql')
    expect(result.path).toBe(path.join(roots.docs, 'shared.sql'))
  })

  it('expands ~ against the home directory', async () => {
    await mkdir(roots.home, { recursive: true })
    await writeFile(path.join(roots.home, 'home.sql'), 'select 3;', 'utf8')
    expect((await service.readText('~/home.sql')).path).toBe(path.join(roots.home, 'home.sql'))
  })

  it('rejects missing files, directories and empty paths', async () => {
    await expect(service.readText(path.join(base, 'nope.sql'))).rejects.toThrow('does not exist')
    await expect(service.readText(base)).rejects.toThrow('not a file')
    await expect(service.readText('   ')).rejects.toThrow('Invalid @include path')
    await expect(service.readText('bad\0name')).rejects.toThrow('Invalid @include path')
  })

  it('refuses files above 16 MB', async () => {
    const huge = path.join(base, 'huge.sql')
    await writeFile(huge, '')
    await truncate(huge, 17 * 1024 * 1024)
    await expect(service.readText(huge)).rejects.toThrow('limit is 16 MB')
  })
})
