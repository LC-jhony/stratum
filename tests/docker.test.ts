import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { dockerTarget, listDockerContainers } from '../src/main/services/docker'
import { inferDockerKind, publishedPorts, type DockerContainer } from '../src/shared/docker'

/**
 * The Docker helper only reads `GET /containers/json`. These pins keep the daemon mapping (names,
 * images, ports, sorting), the unix-socket/TCP target selection and the actionable errors honest,
 * and pin the image→server-type inference the dialog uses to prefill a connection. dockerode talks
 * to a real HTTP socket here, so its request/response handling is exercised, not mocked.
 */

interface FakeDocker {
  port: number
  requests: { method: string; url: string }[]
  close(): Promise<void>
}

function startFakeDocker(status = 200, payload: unknown = []): Promise<FakeDocker> {
  const requests: FakeDocker['requests'] = []
  const server: Server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '' })
    if (status !== 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({
      port: (server.address() as AddressInfo).port,
      requests,
      close: () => new Promise((r) => { server.close(() => r()) }),
    })
  }))
}

const DAEMON = [
  {
    Id: 'aaa1111111111111',
    Names: ['/zeta'],
    Image: 'postgres:16',
    State: 'running',
    Status: 'Up 2 hours',
    Ports: [
      { IP: '0.0.0.0', PrivatePort: 5432, PublicPort: 55432, Type: 'tcp' },
      { IP: '::', PrivatePort: 5432, PublicPort: 55432, Type: 'tcp' },
    ],
  },
  {
    Id: 'bbb2222222222222',
    Names: ['/alpha'],
    Image: 'rabbitmq:4-management',
    State: 'running',
    Status: 'Up 5 minutes',
    Ports: [
      { IP: '0.0.0.0', PrivatePort: 5672, PublicPort: 5672, Type: 'tcp' },
      { IP: '0.0.0.0', PrivatePort: 15672, PublicPort: 15672, Type: 'tcp' },
      { IP: '0.0.0.0', PrivatePort: 5672, PublicPort: 5672, Type: 'udp' },
    ],
  },
  {
    Id: 'ccc3333333333333',
    Names: [],
    Image: 'internal/tool:1',
    State: 'running',
    Status: 'Up 1 minute',
    Ports: [],
  },
  {
    Id: 'ddd4444444444444',
    Names: ['/exposed-only'],
    Image: 'redis:7',
    State: 'running',
    Status: 'Up 1 minute',
    Ports: [{ IP: '', PrivatePort: 6379, Type: 'tcp' }],
  },
]

describe('docker helper', () => {
  const servers: FakeDocker[] = []

  afterAll(async () => { await Promise.all(servers.map((server) => server.close())) })

  it('lists running containers from a TCP daemon, mapping names, images and ports', async () => {
    const fake = await startFakeDocker(200, DAEMON)
    servers.push(fake)

    const containers = await listDockerContainers({ host: '127.0.0.1', port: fake.port })
    expect(fake.requests.length).toBe(1)
    expect(fake.requests[0].method).toBe('GET')
    expect(fake.requests[0].url.startsWith('/containers/json')).toBe(true)

    expect(containers.map((c) => c.name)).toEqual(['alpha', 'ccc333333333', 'exposed-only', 'zeta'])
    const rabbit = containers[0]
    expect(rabbit.image).toBe('rabbitmq:4-management')
    expect(rabbit.state).toBe('running')
    expect(rabbit.ports).toEqual([
      { privatePort: 5672, publicPort: 5672, type: 'tcp', ip: '0.0.0.0' },
      { privatePort: 15672, publicPort: 15672, type: 'tcp', ip: '0.0.0.0' },
      { privatePort: 5672, publicPort: 5672, type: 'udp', ip: '0.0.0.0' },
    ])
    expect(publishedPorts(rabbit).map((p) => p.publicPort)).toEqual([5672, 15672])
    expect(publishedPorts(containers[2])).toEqual([]) // exposed but not published
  })

  it('builds readable targets for both daemon transports', () => {
    expect(dockerTarget({})).toBe('/var/run/docker.sock')
    expect(dockerTarget({ socketPath: '/run/docker.sock' })).toBe('/run/docker.sock')
    expect(dockerTarget({ host: 'docker.lan' })).toBe('tcp://docker.lan:2375')
    expect(dockerTarget({ host: 'docker.lan', port: 2376, ssl: true })).toBe('https://docker.lan:2376')
  })

  it('explains an unreachable unix socket instead of leaking ENOENT', async () => {
    await expect(listDockerContainers({ socketPath: '/tmp/opencode/no-such-docker.sock' })).rejects.toThrow(/Docker daemon not found/)
  })

  it('explains a refused TCP connection', async () => {
    const fake = await startFakeDocker()
    const port = fake.port
    await fake.close()
    await expect(listDockerContainers({ host: '127.0.0.1', port })).rejects.toThrow(/refused the connection/)
  })

  it('surfaces daemon errors with the API message', async () => {
    const fake = await startFakeDocker(500, { message: 'something exploded' })
    servers.push(fake)
    await expect(listDockerContainers({ host: '127.0.0.1', port: fake.port })).rejects.toThrow(/Docker daemon error .*something exploded/)
  })
})

describe('docker image inference', () => {
  it('recognizes the services this build can connect to, with their container port', () => {
    expect(inferDockerKind('postgres:16')).toEqual({ tileId: 'postgres', kind: 'postgres', label: 'PostgreSQL', privatePort: 5432 })
    expect(inferDockerKind('bitnami/mariadb:11')).toMatchObject({ tileId: 'mysql', kind: 'mysql' })
    expect(inferDockerKind('mongo:7')).toMatchObject({ tileId: 'mongodb', kind: 'mongodb', privatePort: 27017 })
    expect(inferDockerKind('redis:7-alpine')).toMatchObject({ tileId: 'redis', kind: 'redis' })
    expect(inferDockerKind('docker.elastic.co/elasticsearch/elasticsearch:8.13.0')).toMatchObject({ tileId: 'elastic', kind: 'elastic' })
    expect(inferDockerKind('cassandra:5')).toMatchObject({ tileId: 'cassandra', kind: 'cassandra' })
    expect(inferDockerKind('minio/minio:latest')).toMatchObject({ tileId: 's3', kind: 's3', privatePort: 9000 })
    expect(inferDockerKind('rabbitmq:4-management')).toMatchObject({ tileId: 'rabbitmq', kind: 'rabbitmq', privatePort: 15672 })
    expect(inferDockerKind('bitnami/kafka:3.7')).toMatchObject({ tileId: 'kafka', kind: 'kafka' })
    expect(inferDockerKind('fauria/vsftpd')).toMatchObject({ tileId: 'ftp', kind: 'ftp', privatePort: 21 })
  })

  it('does not mistake companion UIs or unrelated images for a data source', () => {
    expect(inferDockerKind('mongo-express:latest')).toBeUndefined()
    expect(inferDockerKind('provectuslabs/kafka-ui:latest')).toBeUndefined()
    expect(inferDockerKind('rediscommander/redis-commander')).toBeUndefined()
    expect(inferDockerKind('nginx:alpine')).toBeUndefined()
    expect(inferDockerKind('')).toBeUndefined()
  })

  it('marks only the published port the client speaks as recommended', () => {
    const container: DockerContainer = {
      id: 'x', name: 'mq', image: 'rabbitmq:4', state: 'running', status: 'Up',
      ports: [
        { privatePort: 5672, publicPort: 5672, type: 'tcp' },
        { privatePort: 15672, publicPort: 15672, type: 'tcp' },
        { privatePort: 1883, publicPort: 1883, type: 'tcp' },
      ],
    }
    const guess = inferDockerKind(container.image)!
    expect(publishedPorts(container).filter((p) => p.privatePort === guess.privatePort).map((p) => p.publicPort)).toEqual([15672])
  })
})
