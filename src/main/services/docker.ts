import Docker from 'dockerode'
import type { DockerContainer, DockerEndpoint, DockerPort } from '../../shared/docker'

/**
 * Read-only Docker daemon access for the connection dialog's helper. The daemon is reached over
 * the local unix socket by default (`/var/run/docker.sock`) or plain TCP (`host`/`port`, optional
 * TLS). Only `GET /containers/json` is ever called: nothing is started, stopped or removed.
 */

const DEFAULT_SOCKET = '/var/run/docker.sock'
const DEFAULT_TCP_PORT = 2375
const DAEMON_TIMEOUT_MS = 10_000

/** Human-readable daemon address for errors and the dialog. */
export function dockerTarget(endpoint: DockerEndpoint): string {
  const host = endpoint.host?.trim()
  if (host) {
    const port = endpoint.port && endpoint.port > 0 ? endpoint.port : DEFAULT_TCP_PORT
    return `${endpoint.ssl ? 'https' : 'tcp'}://${host}:${port}`
  }
  return endpoint.socketPath?.trim() || DEFAULT_SOCKET
}

/** List running containers and the ports the daemon published for them. */
export async function listDockerContainers(endpoint: DockerEndpoint): Promise<DockerContainer[]> {
  const host = endpoint.host?.trim()
  const docker = host
    ? new Docker({
        host,
        port: endpoint.port && endpoint.port > 0 ? endpoint.port : DEFAULT_TCP_PORT,
        protocol: endpoint.ssl ? 'https' : 'http',
        timeout: DAEMON_TIMEOUT_MS,
      })
    : new Docker({ socketPath: endpoint.socketPath?.trim() || DEFAULT_SOCKET, timeout: DAEMON_TIMEOUT_MS })

  let list: Docker.ContainerInfo[]
  try {
    list = await docker.listContainers({ all: false })
  } catch (e) {
    throw new Error(describeError(e, dockerTarget(endpoint)))
  }

  return list
    .map((container) => ({
      id: container.Id,
      name: (container.Names?.[0] ?? container.Id.slice(0, 12)).replace(/^\//, ''),
      image: container.Image,
      state: container.State,
      status: container.Status,
      ports: (container.Ports ?? []).map(
        (port): DockerPort => ({
          privatePort: port.PrivatePort,
          publicPort: port.PublicPort || undefined,
          type: port.Type,
          ip: port.IP || undefined,
        }),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function describeError(e: unknown, target: string): string {
  const error = e as { code?: string; statusCode?: number; message?: string; json?: { message?: string } }
  const detail = error?.json?.message ?? error?.message ?? String(e)
  if (error?.code === 'ENOENT') return `Docker daemon not found (${target}). Is Docker installed and running?`
  if (error?.code === 'ECONNREFUSED') return `Docker daemon refused the connection (${target}). Enable the TCP API or use the unix socket.`
  if (error?.code === 'EACCES' || /permission denied/i.test(detail)) return `Permission denied on ${target}. Add your user to the docker group or fix the socket permissions.`
  if (error?.statusCode === 404) return `Docker API not found (${target}): ${detail}`
  return `Docker daemon error (${target}): ${detail}`
}
