import type { DriverKind } from './types'

/** Data shapes that cross the IPC boundary for the read-only Docker helper. */
export interface DockerEndpoint {
  /** TCP daemon host. When empty, the unix socket below is used instead. */
  host?: string
  port?: number
  ssl?: boolean
  socketPath?: string
}

export interface DockerPort {
  privatePort: number
  publicPort?: number
  type: string
  ip?: string
}

export interface DockerContainer {
  id: string
  name: string
  image: string
  state: string
  status: string
  ports: DockerPort[]
}

export interface DockerKindGuess {
  /** Server-type tile in the dialog (not always equal to `kind`: MariaDB is MySQL). */
  tileId: string
  kind: DriverKind
  label: string
  /** Container-side port the client speaks; used to recommend one of several published ports. */
  privatePort: number
}
