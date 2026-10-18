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
import { CassandraTransport } from './transports/cassandra'
import { ElasticTransport } from './transports/elastic'
import { FtpTransport } from './transports/ftp'
import { KafkaTransport } from './transports/kafka'
import { RabbitMqTransport } from './transports/rabbitmq'
import { S3Transport } from './transports/s3'
import { JdbcTransport } from './transports/jdbc'
import { MongoTransport } from './transports/mongodb'
import { MysqlTransport } from './transports/mysql'
import { PostgresTransport } from './transports/postgres'
import { RedisTransport } from './transports/redis'
import { SqliteTransport } from './transports/sqlite'
import { acquireTunnel } from '../services/sshTunnel'
import type { JdbcSidecar } from '../services/jdbcSidecar'

/** The only place that knows which transport/dialect pairs exist. Add a database here. */
export function createSession(cfg: ConnectionConfig, sidecar: JdbcSidecar): DbSession {
  switch (cfg.kind) {
    case 'postgres': return new DbSession(cfg, new PostgresTransport(cfg), dialects.postgres)
    case 'mysql': return new DbSession(cfg, new MysqlTransport(cfg), dialects.mysql)
    case 'sqlite': return new DbSession(cfg, new SqliteTransport(cfg), dialects.sqlite)
    case 'jdbc': return new DbSession(cfg, new JdbcTransport(cfg, sidecar), dialects[cfg.jdbc?.dialect ?? 'generic'])
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

/**
 * createSession plus the SSH connection helper: when the config enables a tunnel, the session is
 * built against the rewritten address (127.0.0.1:<local port>) and `close()` releases the tunnel,
 * which tears the SSH connection down once the last session using it is gone.
 */
export async function createSessionWithTunnel(cfg: ConnectionConfig, sidecar: JdbcSidecar): Promise<DbSession> {
  const { config, release } = await acquireTunnel(cfg)
  const session = createSession(config, sidecar)
  if (!cfg.ssh?.enabled) return session
  const close = session.close.bind(session)
  session.close = () => close().finally(release) // release() is idempotent, close() may run twice
  return session
}
