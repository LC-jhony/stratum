import { describe, expect, it } from 'vitest'
import { dockerTarget, listDockerContainers } from '../src/main/services/docker'
import { publishedPorts, type DockerEndpoint } from '../src/shared/docker'

/**
 * Live Docker checks — skipped unless a daemon endpoint is provided:
 *
 *   STRATUM_TEST_DOCKER=unix:///var/run/docker.sock   or   tcp://127.0.0.1:2375
 *
 * The suite only calls `GET /containers/json` (read-only): it lists running containers twice and
 * checks the shape, never starting, stopping or removing anything.
 */
const target = process.env.STRATUM_TEST_DOCKER
const suite = target ? describe : describe.skip

function parseTarget(raw: string): DockerEndpoint {
  const value = raw.trim()
  if (value.startsWith('unix://')) return { socketPath: value.slice('unix://'.length) }
  if (value.startsWith('tcp://') || value.startsWith('http://') || value.startsWith('https://')) {
    const url = new URL(value.replace(/^tcp:/, 'http:'))
    return { host: url.hostname, port: url.port ? Number(url.port) : undefined, ssl: url.protocol === 'https:' }
  }
  return { socketPath: value }
}

suite('Docker live', () => {
  const endpoint = target ? parseTarget(target) : {}

  it('reaches the daemon and lists running containers read-only', async () => {
    const containers = await listDockerContainers(endpoint)
    expect(Array.isArray(containers)).toBe(true)
    for (const container of containers) {
      expect(container.id.length).toBeGreaterThan(0)
      expect(container.name.length).toBeGreaterThan(0)
      expect(container.image.length).toBeGreaterThan(0)
      expect(Array.isArray(container.ports)).toBe(true)
      expect(container.name.startsWith('/')).toBe(false)
    }
    expect(new Set(containers.map((c) => c.id)).size).toBe(containers.length)
  })

  it('reports published TCP ports with both sides of the mapping', async () => {
    const containers = await listDockerContainers(endpoint)
    const published = containers.flatMap((container) => publishedPorts(container).map((port) => ({ container, port })))
    if (published.length === 0) return // a daemon with no published ports is still a valid pass
    for (const { port } of published.slice(0, 20)) {
      expect(Number.isInteger(port.privatePort)).toBe(true)
      expect(port.privatePort).toBeGreaterThan(0)
      expect(port.publicPort).toBeGreaterThan(0)
      expect(port.type).toBe('tcp')
    }
    expect(dockerTarget(endpoint)).toMatch(/^(tcp|https):\/\/|^\//)
  })

  it('returns the same view on a second scan (no mutation)', async () => {
    const first = await listDockerContainers(endpoint)
    const second = await listDockerContainers(endpoint)
    expect(second.map((c) => [c.id, c.name, c.image])).toEqual(first.map((c) => [c.id, c.name, c.image]))
  })
})
