import Fastify, { type FastifyInstance } from 'fastify';
import { MetadataDatabase } from './db/database.js';
import { registerTransferRoutes } from './routes/transfers.js';
import type { StorageNodeClient } from './services/storage-client.js';
import { HttpStorageNodeClient } from './services/storage-client.js';
import type { ChunkReplicator } from './replication/replication.js';
import type { ReplicaReadService } from './replication/read-service.js';
import { HealthMonitor } from './health/monitor.js';
import { registerHealthRoutes } from './health/routes.js';
import { createLoggerOptions } from './hardening/logging.js';
import { RouteRateLimiter } from './hardening/rate-limit.js';

export interface ApiServerOptions {
  logger?: boolean;
  rateLimiter?: RouteRateLimiter;
  clusterSecret?: string;
  allowedNodeIds?: string[];
}

export function buildApiServer(
  database: MetadataDatabase,
  storageClient?: StorageNodeClient,
  replicator?: ChunkReplicator,
  readService?: Pick<ReplicaReadService, 'getChunk'>,
  healthMonitor = new HealthMonitor(database),
  options: ApiServerOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: options.logger === true ? createLoggerOptions() : false });
  const resolvedStorageClient = storageClient ?? new HttpStorageNodeClient('http://localhost:9001');
  app.addContentTypeParser(
    'application/octet-stream',
    (_request, payload, done) => done(null, payload),
  );
  registerTransferRoutes(app, database, resolvedStorageClient, replicator, readService, options.rateLimiter);
  registerHealthRoutes(app, healthMonitor, {
    clusterSecret: options.clusterSecret,
    allowedNodeIds: options.allowedNodeIds,
  });
  return app;
}
