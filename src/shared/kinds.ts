import type { DriverKind } from './types'

/**
 * Provider capabilities, consulted by the renderer to decide which SQL affordances to show
 * (WHERE/ORDER BY bars, :parameters, rename SQL, completion, destructive confirms) and by the
 * connection dialog for defaults. The main process keeps its own registry (db/factory.ts);
 * this one is the single source of truth for the UI.
 */
export interface KindInfo {
  label: string
  /** True when the provider speaks SQL; false for document/key-value sources such as MongoDB. */
  sql: boolean
  /** Default TCP port the connection dialog prefills. */
  defaultPort?: number
}

export const KINDS: Record<DriverKind, KindInfo> = {
  postgres: { label: 'PostgreSQL', sql: true, defaultPort: 5432 },
  mysql: { label: 'MySQL', sql: true, defaultPort: 3306 },
  sqlite: { label: 'SQLite', sql: true },
  jdbc: { label: 'JDBC', sql: true },
  mongodb: { label: 'MongoDB', sql: false, defaultPort: 27017 },
  redis: { label: 'Redis', sql: false, defaultPort: 6379 },
  elastic: { label: 'Elasticsearch', sql: false, defaultPort: 9200 },
  cassandra: { label: 'Cassandra', sql: false, defaultPort: 9042 },
  s3: { label: 'S3', sql: false, defaultPort: 443 },
  ftp: { label: 'FTP', sql: false, defaultPort: 21 },
  kafka: { label: 'Kafka', sql: false, defaultPort: 9092 },
  rabbitmq: { label: 'RabbitMQ', sql: false, defaultPort: 15672 },
}

/** Unknown/undefined kinds are treated as SQL so older stores keep their current behaviour. */
export const isSqlKind = (kind: DriverKind | undefined): boolean => !kind || KINDS[kind]?.sql !== false
