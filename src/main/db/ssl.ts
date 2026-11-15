import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ConnectionConfig } from '../../shared/types'

/** TLS material read from the paths configured on the data source. */
export interface SslMaterial { ca?: Buffer; cert?: Buffer; key?: Buffer; passphrase?: string }

const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p)

async function readPem(file: string | undefined, label: string): Promise<Buffer | undefined> {
  const value = file?.trim()
  if (!value) return undefined
  try {
    return await readFile(expandHome(value))
  } catch (e) {
    throw new Error(`${label} is not readable: ${value} (${e instanceof Error ? e.message : String(e)})`)
  }
}

/**
 * Mutual-TLS material for drivers that accept buffers (pg, mysql2, mongodb). No files are read
 * unless the profile enables SSL and points at them, so existing profiles stay untouched.
 */
export async function sslMaterial(cfg: ConnectionConfig): Promise<SslMaterial | undefined> {
  if (!cfg.ssl) return undefined
  const [ca, cert, key] = await Promise.all([
    readPem(cfg.sslCaPath, 'SSL CA certificate'),
    readPem(cfg.sslClientCertPath, 'SSL client certificate'),
    readPem(cfg.sslClientKeyPath, 'SSL client key'),
  ])
  if (cert && !key) throw new Error('A client certificate needs its private key (SSL client key).')
  if (key && !cert) throw new Error('A client key needs its certificate (SSL client certificate).')
  return { ca, cert, key, passphrase: cfg.sslKeyPassphrase || undefined }
}
