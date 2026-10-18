import type { DockerContainer, DockerKindGuess, DockerPort } from '../shared/docker'

/**
 * Docker helper (read-only): the dialog lists running containers and their published ports so the
 * user can fill host/port (and, when the image gives it away, the server type) without leaving the
 * form. The shapes live in src/shared/docker.ts; the inference is shared by main and renderer tests.
 */

export type { DockerContainer, DockerEndpoint, DockerKindGuess, DockerPort } from '../shared/docker'

/** Companion UIs (mongo-express, kafka-ui, …) must not be mistaken for the database itself. */
const COMPANIONS = [
  /mongo-express|mongo.?express/i,
  /redis-commander|redis-insight|redis.?commander/i,
  /kafka-ui|kafdrop|akhq/i,
  /rabbitmq.*exporter/i,
]

const RULES: { match: RegExp; guess: DockerKindGuess }[] = [
  { match: /postgres|postgis|timescale/i, guess: { tileId: 'postgres', kind: 'postgres', label: 'PostgreSQL', privatePort: 5432 } },
  { match: /mysql|mariadb|percona/i, guess: { tileId: 'mysql', kind: 'mysql', label: 'MySQL', privatePort: 3306 } },
  { match: /mongo/i, guess: { tileId: 'mongodb', kind: 'mongodb', label: 'MongoDB', privatePort: 27017 } },
  { match: /redis|valkey|keydb/i, guess: { tileId: 'redis', kind: 'redis', label: 'Redis', privatePort: 6379 } },
  { match: /elasticsearch|opensearch/i, guess: { tileId: 'elastic', kind: 'elastic', label: 'Elasticsearch', privatePort: 9200 } },
  { match: /cassandra|scylla/i, guess: { tileId: 'cassandra', kind: 'cassandra', label: 'Cassandra', privatePort: 9042 } },
  { match: /minio|seaweedfs/i, guess: { tileId: 's3', kind: 's3', label: 'S3', privatePort: 9000 } },
  { match: /rabbitmq/i, guess: { tileId: 'rabbitmq', kind: 'rabbitmq', label: 'RabbitMQ', privatePort: 15672 } },
  { match: /kafka|redpanda/i, guess: { tileId: 'kafka', kind: 'kafka', label: 'Kafka', privatePort: 9092 } },
  { match: /ftp/i, guess: { tileId: 'ftp', kind: 'ftp', label: 'FTP', privatePort: 21 } },
]

/**
 * Guess the server type from a container image reference.
 * @example inferDockerKind('bitnami/postgresql:16') → PostgreSQL (postgres, port 5432)
 */
export function inferDockerKind(image: string): DockerKindGuess | undefined {
  const name = image.trim()
  if (!name || COMPANIONS.some((pattern) => pattern.test(name))) return undefined
  return RULES.find((rule) => rule.match.test(name))?.guess
}

/** Published TCP ports of a container, in the order the daemon returned them. */
export function publishedPorts(container: DockerContainer): DockerPort[] {
  return container.ports.filter((port) => port.type === 'tcp' && typeof port.publicPort === 'number' && port.publicPort > 0)
}
