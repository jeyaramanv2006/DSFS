import Fastify, { type FastifyInstance } from 'fastify';
import { MetadataDatabase } from './db/database.js';
import { registerTransferRoutes } from './routes/transfers.js';
import type { StorageNodeClient } from './services/storage-client.js';
import { HttpStorageNodeClient } from './services/storage-client.js';
import type { ChunkReplicator } from './replication/replication.js';
import type { ReplicaReadService } from './replication/read-service.js';

export function buildApiServer(
  database: MetadataDatabase,
  storageClient: StorageNodeClient = new HttpStorageNodeClient('http://localhost:9001'),
  replicator?: ChunkReplicator,
  readService?: Pick<ReplicaReadService, 'getChunk'>,
): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addContentTypeParser(
    'application/octet-stream',
    (_request, payload, done) => done(null, payload),
  );
  registerTransferRoutes(app, database, storageClient, replicator, readService);
  return app;
}
