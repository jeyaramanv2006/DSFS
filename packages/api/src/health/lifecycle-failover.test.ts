import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { MetadataDatabase } from '../db/database.js';
import { buildApiServer } from '../server.js';
import { HealthMonitor } from './monitor.js';
import { ReplicaReadService, type ReplicaReadTarget } from '../replication/read-service.js';
import { BackgroundWorkerManager } from '../workers/manager.js';
import { ExpirationSweeper, StorageReconciler } from '../cleanup/cleanup.js';
import { RecoveryService } from '../recovery/recovery.js';
import type { StorageNodeClient, StoredChunkResult } from '../services/storage-client.js';

const TEST_SECRET = 'cluster-secret-key-12345';
const AUTH_TOKEN = '1111111111111111111111111111111111111111111111111111111111111111';

class MockStorageClient implements StorageNodeClient {
  public constructor(
    private readonly handler: (chunkId: string) => Promise<Readable> = async () => Readable.from(''),
  ) {}

  public async putChunk(): Promise<StoredChunkResult> {
    return { sizeBytes: 0, checksumSha256: '' };
  }

  public async getChunk(chunkId: string): Promise<Readable> {
    return this.handler(chunkId);
  }

  public async deleteChunk(): Promise<boolean> {
    return true;
  }

  public async listChunks(): Promise<string[]> {
    return [];
  }
}

describe('Heartbeat Lifecycle and Replica Failover Integration', () => {
  let database: MetadataDatabase | undefined;
  let app: Awaited<ReturnType<typeof buildApiServer>> | undefined;
  let monitor: HealthMonitor | undefined;

  afterEach(async () => {
    monitor?.stop();
    await app?.close();
    database?.close();
  });

  describe('Heartbeat lifecycle & authentication', () => {
    it('enforces strict service auth and validates heartbeat payloads', async () => {
      database = new MetadataDatabase();
      database.registerStorageNode({
        nodeId: 'node-pc-b',
        endpointUrl: 'http://192.168.1.50:9001',
        status: 'UNAVAILABLE',
        heartbeatAt: '1970-01-01T00:00:00.000Z',
      });

      monitor = new HealthMonitor(database);
      app = buildApiServer(database, undefined, undefined, undefined, monitor, {
        clusterSecret: TEST_SECRET,
        allowedNodeIds: ['node-pc-b', 'node-pc-c'],
      });

      // 1. Missing Authorization -> 401
      const noAuth = await app.inject({
        method: 'POST',
        url: '/api/nodes/heartbeat',
        payload: {
          nodeId: 'node-pc-b',
          endpointUrl: 'http://192.168.1.50:9001',
          totalCapacityBytes: 1000,
          usedCapacityBytes: 100,
          activeOperations: 0,
        },
      });
      expect(noAuth.statusCode).toBe(401);
      expect(noAuth.json()).toEqual({ error: 'UNAUTHORIZED' });

      // 2. Wrong Authorization secret -> 401
      const wrongAuth = await app.inject({
        method: 'POST',
        url: '/api/nodes/heartbeat',
        headers: { authorization: 'Bearer wrong-secret' },
        payload: {
          nodeId: 'node-pc-b',
          endpointUrl: 'http://192.168.1.50:9001',
          totalCapacityBytes: 1000,
          usedCapacityBytes: 100,
          activeOperations: 0,
        },
      });
      expect(wrongAuth.statusCode).toBe(401);

      // 3. Payload validation failure: used > total -> 400
      const invalidPayload = await app.inject({
        method: 'POST',
        url: '/api/nodes/heartbeat',
        headers: { authorization: `Bearer ${TEST_SECRET}` },
        payload: {
          nodeId: 'node-pc-b',
          endpointUrl: 'http://192.168.1.50:9001',
          totalCapacityBytes: 100,
          usedCapacityBytes: 500, // Invalid: exceeds total
          activeOperations: 0,
        },
      });
      expect(invalidPayload.statusCode).toBe(400);
      expect(invalidPayload.json()).toEqual({ error: 'VALIDATION_ERROR' });

      // 4. Node not in allowed list -> 403
      const unconfiguredNode = await app.inject({
        method: 'POST',
        url: '/api/nodes/heartbeat',
        headers: { authorization: `Bearer ${TEST_SECRET}` },
        payload: {
          nodeId: 'node-rogue',
          endpointUrl: 'http://192.168.1.99:9001',
          totalCapacityBytes: 1000,
          usedCapacityBytes: 100,
          activeOperations: 0,
        },
      });
      expect(unconfiguredNode.statusCode).toBe(403);
      expect(unconfiguredNode.json()).toEqual({ error: 'NODE_NOT_CONFIGURED' });

      // 5. Endpoint URL mismatch with existing registration -> 403
      const endpointMismatch = await app.inject({
        method: 'POST',
        url: '/api/nodes/heartbeat',
        headers: { authorization: `Bearer ${TEST_SECRET}` },
        payload: {
          nodeId: 'node-pc-b',
          endpointUrl: 'http://192.168.1.200:9001', // Mismatched URL
          totalCapacityBytes: 1000,
          usedCapacityBytes: 100,
          activeOperations: 0,
        },
      });
      expect(endpointMismatch.statusCode).toBe(403);
      expect(endpointMismatch.json()).toEqual({ error: 'ENDPOINT_MISMATCH' });

      // 6. Valid heartbeat -> 200, updates status to HEALTHY
      const valid = await app.inject({
        method: 'POST',
        url: '/api/nodes/heartbeat',
        headers: { authorization: `Bearer ${TEST_SECRET}` },
        payload: {
          nodeId: 'node-pc-b',
          endpointUrl: 'http://192.168.1.50:9001',
          totalCapacityBytes: 50_000_000,
          usedCapacityBytes: 5_000_000,
          activeOperations: 1,
        },
      });
      expect(valid.statusCode).toBe(200);
      expect(valid.json()).toEqual({ acknowledged: true });

      const nodeInDb = database.getStorageNode('node-pc-b');
      expect(nodeInDb?.status).toBe('HEALTHY');
      expect(nodeInDb?.used_capacity_bytes).toBe(5_000_000);
      expect(nodeInDb?.active_operations).toBe(1);

      // Verify rejected heartbeats were recorded in cluster_events
      const rejectedEvents = database.listClusterEvents({ eventType: 'HEARTBEAT_REJECTED' });
      expect(rejectedEvents.length).toBeGreaterThanOrEqual(4);
    });

    it('transitions nodes through HEALTHY -> UNHEALTHY -> UNAVAILABLE on heartbeat timeouts and recovers', () => {
      database = new MetadataDatabase();
      let fakeTime = new Date('2026-10-20T12:00:00.000Z');
      monitor = new HealthMonitor(
        database,
        () => fakeTime,
        { unhealthyAfterMs: 6000, unavailableAfterMs: 12000 },
      );

      monitor.recordHeartbeat({
        nodeId: 'node-pc-b',
        endpointUrl: 'http://192.168.1.50:9001',
        totalCapacityBytes: 1000,
        usedCapacityBytes: 100,
        activeOperations: 0,
      });
      expect(database.getStorageNode('node-pc-b')?.status).toBe('HEALTHY');

      // T + 7s: node becomes UNHEALTHY
      fakeTime = new Date('2026-10-20T12:00:07.000Z');
      const t1 = monitor.refresh();
      expect(t1).toEqual([{ nodeId: 'node-pc-b', previous: 'HEALTHY', current: 'UNHEALTHY' }]);
      expect(database.getStorageNode('node-pc-b')?.status).toBe('UNHEALTHY');

      // T + 13s: node becomes UNAVAILABLE
      fakeTime = new Date('2026-10-20T12:00:13.000Z');
      const t2 = monitor.refresh();
      expect(t2).toEqual([{ nodeId: 'node-pc-b', previous: 'UNHEALTHY', current: 'UNAVAILABLE' }]);
      expect(database.getStorageNode('node-pc-b')?.status).toBe('UNAVAILABLE');

      // T + 15s: Fresh heartbeat arrives -> recovers to HEALTHY
      fakeTime = new Date('2026-10-20T12:00:15.000Z');
      monitor.recordHeartbeat({
        nodeId: 'node-pc-b',
        endpointUrl: 'http://192.168.1.50:9001',
        totalCapacityBytes: 1000,
        usedCapacityBytes: 100,
        activeOperations: 0,
      });
      expect(database.getStorageNode('node-pc-b')?.status).toBe('HEALTHY');

      const recoveryEvents = database.listClusterEvents({ eventType: 'NODE_RECOVERED' });
      expect(recoveryEvents).toHaveLength(1);
      expect(recoveryEvents[0].node_id).toBe('node-pc-b');
    });
  });

  describe('Route-level replica failover and error fallback', () => {
    it('automatically reads from secondary replica when primary node is unavailable or fails', async () => {
      database = new MetadataDatabase();
      database.registerStorageNode({
        nodeId: 'node-pc-b',
        endpointUrl: 'http://192.168.1.50:9001',
        status: 'UNAVAILABLE',
      });
      database.registerStorageNode({
        nodeId: 'node-pc-c',
        endpointUrl: 'http://192.168.1.51:9002',
        status: 'HEALTHY',
      });

      const transfer = database.createTransfer({
        authToken: AUTH_TOKEN,
        totalSizeBytes: 10,
        chunkCount: 1,
        chunkSizeBytes: 10,
        encryptedFileName: null,
        ttlSeconds: 600,
        maxDownloads: 2,
      });

      const chunkContent = Buffer.from('chunk-data');
      const checksum = createHash('sha256').update(chunkContent).digest('hex');

      const chk = database.recordStoredChunk(transfer.fileId, 0, {
        sizeBytes: 10,
        checksumSha256: checksum,
      });
      // Both PC B and PC C hold replicas of chunk 0
      database.recordConfirmedReplicas(chk.chunkId, ['node-pc-b', 'node-pc-c']);
      database.finalizeTransfer(transfer.fileId);

      // Node B client throws (simulating down node); Node C client succeeds
      const targets: ReplicaReadTarget[] = [
        {
          nodeId: 'node-pc-b',
          client: new MockStorageClient(async () => {
            throw new Error('connect ECONNREFUSED 192.168.1.50:9001');
          }),
        },
        {
          nodeId: 'node-pc-c',
          client: new MockStorageClient(async () => Readable.from(chunkContent)),
        },
      ];

      const readService = new ReplicaReadService(database, targets);
      app = buildApiServer(database, undefined, undefined, readService);

      // 1. Acquire download lease
      const accessRes = await app.inject({
        method: 'POST',
        url: `/api/transfers/${transfer.fileId}/access`,
        headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      });
      expect(accessRes.statusCode).toBe(200);
      const downloadToken = accessRes.json().downloadToken;

      // 2. Fetch chunk: route uses readService, detects Node B down, and streams from Node C
      const chunkRes = await app.inject({
        method: 'GET',
        url: `/api/transfers/${transfer.fileId}/chunks/0`,
        headers: { authorization: `Bearer ${downloadToken}` },
      });

      expect(chunkRes.statusCode).toBe(200);
      expect(chunkRes.rawPayload.toString('utf8')).toBe('chunk-data');
      expect(chunkRes.headers['content-type']).toBe('application/octet-stream');
    });

    it('returns 503 NO_REPLICAS_AVAILABLE when all replica nodes fail', async () => {
      database = new MetadataDatabase();
      database.registerStorageNode({ nodeId: 'node-pc-b', endpointUrl: 'http://b', status: 'HEALTHY' });
      database.registerStorageNode({ nodeId: 'node-pc-c', endpointUrl: 'http://c', status: 'HEALTHY' });

      const transfer = database.createTransfer({
        authToken: AUTH_TOKEN,
        totalSizeBytes: 8,
        chunkCount: 1,
        chunkSizeBytes: 8,
        encryptedFileName: null,
        ttlSeconds: 600,
        maxDownloads: 1,
      });

      const chunkContent = Buffer.from('data1234');
      const checksum = createHash('sha256').update(chunkContent).digest('hex');

      const chk = database.recordStoredChunk(transfer.fileId, 0, {
        sizeBytes: 8,
        checksumSha256: checksum,
      });
      database.recordConfirmedReplicas(chk.chunkId, ['node-pc-b', 'node-pc-c']);
      database.finalizeTransfer(transfer.fileId);

      // Both nodes fail
      const targets: ReplicaReadTarget[] = [
        {
          nodeId: 'node-pc-b',
          client: new MockStorageClient(async () => {
            throw new Error('node B network unreachable');
          }),
        },
        {
          nodeId: 'node-pc-c',
          client: new MockStorageClient(async () => {
            throw new Error('node C disk I/O error');
          }),
        },
      ];

      const readService = new ReplicaReadService(database, targets);
      app = buildApiServer(database, undefined, undefined, readService);

      const accessRes = await app.inject({
        method: 'POST',
        url: `/api/transfers/${transfer.fileId}/access`,
        headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      });
      const downloadToken = accessRes.json().downloadToken;

      const chunkRes = await app.inject({
        method: 'GET',
        url: `/api/transfers/${transfer.fileId}/chunks/0`,
        headers: { authorization: `Bearer ${downloadToken}` },
      });

      expect(chunkRes.statusCode).toBe(503);
      expect(chunkRes.json()).toEqual({ error: 'NODE_UNAVAILABLE' });

      const unavailableEvents = database.listClusterEvents({ eventType: 'CHUNK_UNAVAILABLE' });
      expect(unavailableEvents).toHaveLength(1);
      expect(unavailableEvents[0].severity).toBe('ERROR');
    });

    it('manages background worker intervals cleanly across lifecycle', () => {
      database = new MetadataDatabase();
      const nodeTargets = [{ nodeId: 'node-pc-b', client: new MockStorageClient(async () => Readable.from('')) }];
      const sweeper = new ExpirationSweeper(database, nodeTargets);
      const reconciler = new StorageReconciler(database, nodeTargets);
      const recovery = new RecoveryService(database, nodeTargets);

      const manager = new BackgroundWorkerManager(database, sweeper, reconciler, recovery, {
        expirationSweepIntervalMs: 50,
        reconciliationIntervalMs: 50,
        recoveryIntervalMs: 50,
      });

      expect(manager.isStarted()).toBe(false);
      manager.start();
      expect(manager.isStarted()).toBe(true);

      // Idempotent start
      manager.start();
      expect(manager.isStarted()).toBe(true);

      manager.stop();
      expect(manager.isStarted()).toBe(false);

      // Idempotent stop
      manager.stop();
      expect(manager.isStarted()).toBe(false);
    });
  });
});
