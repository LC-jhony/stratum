import { mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { DriverService } from '../src/main/services/driverService'
import type { DesktopService } from '../src/main/services/desktopService'

const root = mkdtempSync(path.join(tmpdir(), 'stratum-drivers-'))
afterAll(() => rm(root, { recursive: true, force: true }))

interface FakeDesktop { files: string[]; revealed: string[]; folders: string[] }
const fake = (files: string[] = []): FakeDesktop & DesktopService => {
  const state: FakeDesktop = { files, revealed: [], folders: [] }
  return Object.assign(state, {
    pickFiles: async () => state.files,
    reveal: (file: string) => { state.revealed.push(file) },
    openFolder: async (dir: string) => { state.folders.push(dir) },
  }) as FakeDesktop & DesktopService
}

let counter = 0
const sandbox = () => {
  const dir = path.join(root, `case-${++counter}`)
  const source = path.join(dir, 'source')
  writeFileSync(path.join(root, '.keep'), '')
  return { dir: path.join(dir, 'drivers'), source }
}

beforeEach(async () => { await mkdir(root, { recursive: true }) })

describe('DriverService', () => {
  it('starts empty and creates the managed folder', async () => {
    const { dir } = sandbox()
    const service = new DriverService(dir, fake())
    expect(await service.list()).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  it('copies selected JARs with size and modification metadata', async () => {
    const { dir, source } = sandbox()
    await mkdir(source, { recursive: true })
    const a = path.join(source, 'postgresql-42.7.jar')
    const b = path.join(source, 'ojdbc11.jar')
    writeFileSync(a, 'a')
    writeFileSync(b, 'bb')
    const service = new DriverService(dir, fake([a, b]))
    const jars = await service.add()
    expect(jars.map((j) => j.name)).toEqual(['ojdbc11.jar', 'postgresql-42.7.jar'])
    expect(jars.find((j) => j.name === 'ojdbc11.jar')?.size).toBe(2)
    expect(jars.every((j) => j.path.startsWith(dir))).toBe(true)
  })

  it('never overwrites a managed JAR with the same name', async () => {
    const { dir, source } = sandbox()
    await mkdir(source, { recursive: true })
    const jar = path.join(source, 'driver.jar')
    writeFileSync(jar, 'one')
    const service = new DriverService(dir, fake([jar]))
    await service.add()
    writeFileSync(jar, 'two')
    const jars = await service.add()
    expect(jars.map((j) => j.name)).toEqual(['driver-2.jar', 'driver.jar'])
    expect((await readdir(dir)).sort()).toEqual(['driver-2.jar', 'driver.jar'])
  })

  it('removes only managed JARs and rejects path escapes', async () => {
    const { dir, source } = sandbox()
    await mkdir(source, { recursive: true })
    const jar = path.join(source, 'x.jar')
    writeFileSync(jar, 'x')
    const service = new DriverService(dir, fake([jar]))
    const [managed] = await service.add()
    expect(await service.remove(managed.path)).toEqual([])
    await expect(service.remove(path.join(root, 'outside.jar'))).rejects.toThrow('Invalid driver path')
    await expect(service.remove(path.dirname(managed.path))).rejects.toThrow('Invalid driver path')
  })

  it('rejects non-JAR selections and passes reveal/openFolder to the desktop', async () => {
    const { dir, source } = sandbox()
    await mkdir(source, { recursive: true })
    const txt = path.join(source, 'driver.zip')
    writeFileSync(txt, 'x')
    const desktop = fake([txt])
    const service = new DriverService(dir, desktop)
    await expect(service.add()).rejects.toThrow('not a JAR')
    await service.openFolder()
    expect(desktop.folders).toEqual([dir])
  })
})
