import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'node:net'
import type { DbSession } from '../src/main/db/session'
import { closeAllTunnels } from '../src/main/services/sshTunnel'
import type { JdbcSidecar } from '../src/main/services/jdbcSidecar'
import { SessionFactory } from '../src/main/services/sessionFactory'
import type { ConnectionConfig } from '../src/shared/types'
import { listen, startSshd } from './helpers/sshd'

/**
 * End-to-end check of the SSH connection helper: the MongoDB driver must reach a real mongod that
 * is only addressable through an in-process sshd, exactly as the app does it (SessionFactory
 * rewrites the URI, forwards bytes, and releases the tunnel when the session closes).
 *
 * Skipped unless a server is provided, same switches as mongoLive:
 *   STRATUM_TEST_MONGODB_URI=mongodb://…   STRATUM_TEST_MONGODB_MEMORY=1
 */
const provided = process.env.STRATUM_TEST_MONGODB_URI
const memory = process.env.STRATUM_TEST_MONGODB_MEMORY === '1'
const suite = provided || memory ? describe : describe.skip

suite('ssh tunnel + mongodb live', () => {
  let session: DbSession
  let stopServer: (() => Promise<void>) | undefined
  let sshd: net.Server | undefined
  const db = 'stratum_tunnel'

  beforeAll(async () => {
    let uri = provided
    if (!uri) {
      const { MongoMemoryServer } = await import('mongodb-memory-server')
      const server = await MongoMemoryServer.create()
      uri = server.getUri(db)
      stopServer = async () => { await server.stop() }
    }
    const { MongoClient } = await import('mongodb')
    const client = new MongoClient(uri)
    try {
      await client.connect()
      await client.db(db).collection('users').insertMany([{ name: 'ada', age: 36 }, { name: 'grace', age: 45 }])
    } finally { await client.close() }

    sshd = startSshd('s3cret')
    const sshPort = await listen(sshd)
    const cfg: ConnectionConfig = {
      id: 'tunnel-live', name: 'tunnel-live', kind: 'mongodb', uri, database: db,
      ssh: { enabled: true, host: '127.0.0.1', port: sshPort, user: 'tester', authType: 'password', password: 's3cret' },
    }
    session = await new SessionFactory({} as JdbcSidecar).createWithTunnel(cfg)
    await session.open()
  }, 120_000)

  afterAll(async () => {
    await session?.close().catch(() => undefined)
    await closeAllTunnels()
    sshd?.close()
    await stopServer?.()
  })

  it('reaches mongod only through the forwarded local port', async () => {
    expect(session.version).toMatch(/^\d+\.\d+\.\d+/)
    const url = new URL(session.config.uri!)
    expect(url.hostname).toBe('127.0.0.1')
    expect(url.port).not.toBe('27017')
    const r = await session.execute('db.users.find({}, {name:1, _id:0}).sort({name:1})')
    expect(r.error).toBeUndefined()
    expect(r.rows.map((row) => row[0])).toEqual(['ada', 'grace'])
  })

  it('releases the tunnel when the session closes', async () => {
    const port = Number(new URL(session.config.uri!).port)
    await session.close()
    await expect(new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1')
      s.on('connect', () => { s.destroy(); resolve('connected') })
      s.on('error', reject)
    })).rejects.toBeTruthy()
  })
})
