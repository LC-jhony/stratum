import { access, copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DriverJar } from '../../shared/drivers'
import { logger } from '../logger'
import type { DesktopService } from './desktopService'

/** A JDBC driver larger than this is almost certainly not a driver; refuse before copying it. */
const MAX_JAR_BYTES = 512 * 1024 * 1024

const exists = async (file: string) => access(file).then(() => true, () => false)

/**
 * Owns `<userData>/drivers`: JARs are copied (not referenced) so a driver cannot disappear when the
 * original download folder is cleaned, and every path is validated to stay inside the managed
 * folder before the renderer can delete or reveal it.
 */
export class DriverService {
  constructor(private readonly dir: string, private readonly desktop: DesktopService) {}

  private resolve(file: string): string {
    const root = path.resolve(this.dir)
    const full = path.resolve(file)
    if (full === root || !full.startsWith(root + path.sep)) throw new Error('Invalid driver path')
    return full
  }

  private async ensureDir(): Promise<void> { await mkdir(this.dir, { recursive: true }) }

  /** Managed JARs, name order, with size and modification time for the manager list. */
  async list(): Promise<DriverJar[]> {
    await this.ensureDir()
    const entries = await readdir(this.dir, { withFileTypes: true })
    const jars: DriverJar[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar')) continue
      const full = path.join(this.dir, entry.name)
      const info = await stat(full)
      jars.push({ path: full, name: entry.name, size: info.size, modifiedAt: info.mtimeMs })
    }
    return jars.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Copy the files chosen in the native multi-select dialog; existing names get a numeric suffix. */
  async add(): Promise<DriverJar[]> {
    const files = await this.desktop.pickFiles([{ name: 'JDBC driver', extensions: ['jar'] }])
    if (!files.length) return this.list()
    await this.ensureDir()
    for (const file of files) {
      const info = await stat(file)
      if (!info.isFile()) continue
      if (!file.toLowerCase().endsWith('.jar')) throw new Error(`${path.basename(file)} is not a JAR file.`)
      if (info.size > MAX_JAR_BYTES) throw new Error(`${path.basename(file)} is larger than 512 MB.`)
      const name = await this.freeName(path.basename(file))
      await copyFile(file, path.join(this.dir, name))
      logger.info('driver jar added', { name, bytes: info.size })
    }
    return this.list()
  }

  async remove(file: string): Promise<DriverJar[]> {
    const full = this.resolve(file)
    await rm(full, { force: true })
    logger.info('driver jar removed', { name: path.basename(full) })
    return this.list()
  }

  reveal(file: string): void { this.desktop.reveal(this.resolve(file)) }

  async openFolder(): Promise<void> {
    await this.ensureDir()
    await this.desktop.openFolder(this.dir)
  }

  private async freeName(name: string): Promise<string> {
    const ext = path.extname(name)
    const base = name.slice(0, name.length - ext.length)
    let candidate = name
    for (let i = 2; await exists(path.join(this.dir, candidate)); i++) candidate = `${base}-${i}${ext}`
    return candidate
  }
}
