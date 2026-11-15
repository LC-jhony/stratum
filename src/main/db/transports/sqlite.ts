import { promises as fs } from 'node:fs'
import path from 'node:path'
import initSqlJs, { type Database } from 'sql.js'
import type { ConnectionConfig, RawResult } from '../../../shared/types'
import { returnsRows } from '../../../core/sql'
import type { Transport } from '../types'

/** SQLite through sql.js (WASM): no native modules, identical on Windows/macOS/Linux. */
export class SqliteTransport implements Transport {
  private db?: Database
  private inTx = false
  private seq = 0
  /** File state when it was loaded; a different value means someone else wrote it. */
  private disk?: { mtimeMs: number; size: number }

  constructor(private cfg: ConnectionConfig) {}

  async open() {
    const SQL = await initSqlJs({ locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f) })
    const file = this.cfg.filePath
    let data: Uint8Array | undefined
    if (file && file !== ':memory:') {
      try {
        const st = await fs.stat(file)
        data = await fs.readFile(file)
        this.disk = { mtimeMs: st.mtimeMs, size: st.size }
      } catch (e) {
        // Only "there is no file yet" may silently start an empty database.
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        this.disk = undefined
      }
    }
    this.db = new SQL.Database(data)
    this.db.run('PRAGMA foreign_keys = ON')
    return { version: String(this.db.exec('select sqlite_version()')[0]?.values[0]?.[0] ?? '') }
  }

  async query(sql: string): Promise<RawResult> {
    const db = this.db!
    if (returnsRows(sql)) {
      const r = db.exec(sql)[0]
      return { columns: (r?.columns ?? []).map((name) => ({ name })), rows: (r?.values ?? []) as unknown[][] }
    }
    db.run(sql)
    const affectedRows = db.getRowsModified()
    // export() reopens the DB and would discard an open transaction, so only persist outside one.
    if (/^\s*(begin|savepoint)\b/i.test(sql)) this.inTx = true
    else if (/^\s*(commit|end|rollback)\b/i.test(sql)) { this.inTx = false; if (!/^\s*rollback/i.test(sql)) await this.persist() }
    else if (!this.inTx) await this.persist()
    return { columns: [], rows: [], affectedRows }
  }

  private async persist() {
    const file = this.cfg.filePath
    if (!file || file === ':memory:' || this.cfg.readonly) return
    // Never overwrite changes made by another process since this connection opened the file.
    let current: { mtimeMs: number; size: number } | undefined
    try {
      const st = await fs.stat(file)
      current = { mtimeMs: st.mtimeMs, size: st.size }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      current = undefined
    }
    if (this.disk && (!current || current.mtimeMs !== this.disk.mtimeMs || current.size !== this.disk.size)) {
      throw new Error(`SQLite file "${file}" changed on disk since it was opened. Close and reopen the data source before writing, so external changes are not overwritten.`)
    }
    if (!this.disk && current) {
      throw new Error(`SQLite file "${file}" was created on disk since the data source opened. Close and reopen it before writing.`)
    }
    // Write a sibling temp file first and rename it into place: a crash can never leave a half-written database.
    const tmp = `${file}.${process.pid}.${++this.seq}.tmp`
    await fs.writeFile(tmp, Buffer.from(this.db!.export()))
    await fs.rename(tmp, file)
    const st = await fs.stat(file)
    this.disk = { mtimeMs: st.mtimeMs, size: st.size }
    this.db!.run('PRAGMA foreign_keys = ON') // export() resets pragmas
  }

  async cancel() { /* sql.js executes synchronously; nothing to interrupt */ }
  inTransaction(): boolean { return this.inTx }
  async ping() { this.db?.exec('select 1') }
  async close() { this.db?.close(); this.db = undefined }
}
