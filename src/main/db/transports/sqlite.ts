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
  constructor(private cfg: ConnectionConfig) {}
  async open() {
    const SQL = await initSqlJs({ locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f) })
    const file = this.cfg.filePath
    let data: Uint8Array | undefined
    if (file && file !== ':memory:') { try { data = await fs.readFile(file) } catch { /* new file is created on first write */ } }
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
    await fs.writeFile(file, Buffer.from(this.db!.export()))
    this.db!.run('PRAGMA foreign_keys = ON') // export() resets pragmas
  }
  async cancel() { /* sql.js executes synchronously; nothing to interrupt */ }
  async close() { this.db?.close(); this.db = undefined }
}
