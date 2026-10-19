import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MetadataDatabase } from './db/database.js';
import { buildApiServer } from './server.js';
import { PlacementService } from './placement/service.js';
import { ReplicationService } from './replication/replication.js';
import { HttpStorageNodeClient } from './services/storage-client.js';
import { ReplicaReadService } from './replication/read-service.js';
import { HealthMonitor } from './health/monitor.js';

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

const unhealthyAfterMs = Number(process.env.HEARTBEAT_UNHEALTHY_MS ?? 6000);
const unavailableAfterMs = Number(process.env.HEARTBEAT_UNAVAILABLE_MS ?? 12000);
const healthMonitorIntervalMs = Number(process.env.HEALTH_MONITOR_INTERVAL_MS ?? 2000);

const healthMonitor = new HealthMonitor(
  database,
  () => new Date(),
  { unhealthyAfterMs, unavailableAfterMs },
);
healthMonitor.start(healthMonitorIntervalMs);

const app = buildApiServer(
  database,
  nodeTargets[0]?.client ?? new HttpStorageNodeClient('http://localhost:9001', clusterSecret),
  replicator,
  new ReplicaReadService(database, nodeTargets),
  healthMonitor,
  {
    logger: true,
    clusterSecret,
    allowedNodeIds: nodeDefinitions.map(([nodeId]) => nodeId),
  },
);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Shutting down API server gracefully...');
  try {
    healthMonitor.stop();
    await app.close();
    database.close();
  } catch (err) {
    app.log.error(err, 'Error during shutdown');
    process.exitCode = 1;
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 8080),
  });
} catch (error) {
  app.log.error(error);
  healthMonitor.stop();
  database.close();
  process.exitCode = 1;
}

