import type { ConnectionConfig } from '../../shared/types'
import { dialects } from './dialects'
import { createCassandraDialect } from './cassandraDialect'
import { createElasticDialect } from './elasticDialect'
import { createFtpDialect } from './ftpDialect'
import { createKafkaDialect } from './kafkaDialect'
import { createMongoDialect } from './mongoDialect'
import { createRabbitDialect } from './rabbitmqDialect'
import { createRedisDialect } from './redisDialect'
import { createS3Dialect } from './s3Dialect'
import { DbSession } from './session'
import type { Transport } from './types'
import { CassandraTransport } from './transports/cassandra'
import { ElasticTransport } from './transports/elastic'
import { FtpTransport } from './transports/ftp'
import { KafkaTransport } from './transports/kafka'
import { RabbitMqTransport } from './transports/rabbitmq'
import { S3Transport } from './transports/s3'
import { MongoTransport } from './transports/mongodb'
import { MysqlTransport } from './transports/mysql'
import { PostgresTransport } from './transports/postgres'
import { RedisTransport } from './transports/redis'
import { SqliteTransport } from './transports/sqlite'

/** Transport construction that needs a process/driver host (today only JDBC). */
export interface SessionDependencies {
  jdbcTransport?: (config: ConnectionConfig) => Transport
}

/**
 * Pure registry: config + injected transport factories -> session. No files, processes, SSH or
 * sidecar lifecycle; the application composes those in `SessionFactory`.
 */
export function createSession(cfg: ConnectionConfig, deps: SessionDependencies = {}): DbSession {
  switch (cfg.kind) {
    case 'postgres': return new DbSession(cfg, new PostgresTransport(cfg), dialects.postgres)
    case 'mysql': return new DbSession(cfg, new MysqlTransport(cfg), dialects.mysql)
    case 'sqlite': return new DbSession(cfg, new SqliteTransport(cfg), dialects.sqlite)
    case 'jdbc': {
      if (!deps.jdbcTransport) throw new Error('JDBC transport is not configured')
      return new DbSession(cfg, deps.jdbcTransport(cfg), dialects[cfg.jdbc?.dialect ?? 'generic'])
    }
    case 'mongodb': return new DbSession(cfg, new MongoTransport(cfg), createMongoDialect(cfg))
    case 'redis': {
      const transport = new RedisTransport(cfg)
      return new DbSession(cfg, transport, createRedisDialect(cfg, transport))
    }
    case 'elastic': {
      const transport = new ElasticTransport(cfg)
      return new DbSession(cfg, transport, createElasticDialect(transport))
    }
    case 'cassandra': {
      const transport = new CassandraTransport(cfg)
      return new DbSession(cfg, transport, createCassandraDialect(transport))
    }
    case 's3': {
      const transport = new S3Transport(cfg)
      return new DbSession(cfg, transport, createS3Dialect(transport))
    }
    case 'ftp': {
      const transport = new FtpTransport(cfg)
      return new DbSession(cfg, transport, createFtpDialect(transport))
    }
    case 'kafka': {
      const transport = new KafkaTransport(cfg)
      return new DbSession(cfg, transport, createKafkaDialect(transport))
    }
    case 'rabbitmq': {
      const transport = new RabbitMqTransport(cfg)
      return new DbSession(cfg, transport, createRabbitDialect(transport))
    }
  }
}
