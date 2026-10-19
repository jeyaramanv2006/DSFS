import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MetadataDatabase } from './db/database.js';
import { buildApiServer } from './server.js';
import { PlacementService } from './placement/service.js';
import { ReplicationService } from './replication/replication.js';
import { HttpStorageNodeClient } from './services/storage-client.js';
import { ReplicaReadService } from './replication/read-service.js';

const databasePath = process.env.DB_PATH ?? './data/api.db';
await mkdir(dirname(databasePath), { recursive: true });
const database = new MetadataDatabase(databasePath);
const clusterSecret = process.env.STORAGE_CLUSTER_SECRET;

const nodeDefinitions = (process.env.STORAGE_NODES ?? 'node-1=http://localhost:9001,node-2=http://localhost:9002')
  .split(',')
  .map((entry) => entry.split('='))
  .filter(([nodeId, endpoint]) => !!nodeId && !!endpoint);

for (const [nodeId, endpoint] of nodeDefinitions) {
  database.registerStorageNode({ nodeId, endpointUrl: endpoint, status: 'UNAVAILABLE' });
}

const nodeTargets = nodeDefinitions.map(([nodeId, endpoint]) => ({
  nodeId,
  client: new HttpStorageNodeClient(endpoint, clusterSecret),
}));

const replicator = new ReplicationService(
  database,
  new PlacementService(database),
  nodeTargets,
);

const app = buildApiServer(
  database,
  nodeTargets[0]?.client ?? new HttpStorageNodeClient('http://localhost:9001', clusterSecret),
  replicator,
  new ReplicaReadService(database, nodeTargets),
  undefined,
  {
    logger: true,
    clusterSecret,
    allowedNodeIds: nodeDefinitions.map(([nodeId]) => nodeId),
  },
);

try {
  await app.listen({
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 8080),
  });
} catch (error) {
  app.log.error(error);
  database.close();
  process.exitCode = 1;
}
