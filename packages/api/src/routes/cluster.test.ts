import { afterEach, describe, expect, it } from 'vitest';
import { MetadataDatabase } from '../db/database.js';
import { buildApiServer } from '../server.js';
import { HealthMonitor } from '../health/monitor.js';

describe('Cluster Observability Routes', () => {
  let database: MetadataDatabase | undefined;
  let app: Awaited<ReturnType<typeof buildApiServer>> | undefined;

  afterEach(async () => {
    await app?.close();
    database?.close();
  });

  it('exposes sanitized cluster overview with accurate counts', async () => {
    database = new MetadataDatabase();
    database.registerStorageNode({
      nodeId: 'node-pc-b',
      endpointUrl: 'http://192.168.1.50:9001',
      status: 'HEALTHY',
      totalCapacityBytes: 100_000_000,
      usedCapacityBytes: 25_000_000,
    });
    database.registerStorageNode({
      nodeId: 'node-pc-c',
      endpointUrl: 'http://192.168.1.51:9002',
      status: 'UNHEALTHY',
      totalCapacityBytes: 200_000_000,
      usedCapacityBytes: 50_000_000,
      heartbeatAt: new Date(Date.now() - 20_000).toISOString(),
    });

    const created = database.createTransfer({
      authToken: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      totalSizeBytes: 2048,
      chunkCount: 1,
      chunkSizeBytes: 2048,
      encryptedFileName: 'enc-file',
      ttlSeconds: 3600,
      maxDownloads: 1,
    });

    const stored = database.recordStoredChunk(created.fileId, 0, {
      sizeBytes: 2048,
      checksumSha256: 'deadbeef1234',
    });
    database.recordPlacement(stored.chunkId, ['node-pc-b', 'node-pc-c']);
    database.recordConfirmedReplicas(stored.chunkId, ['node-pc-b']);

    app = buildApiServer(database);

    const res = await app.inject({
      method: 'GET',
      url: '/api/cluster/overview',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalNodes).toBe(2);
    expect(body.healthyNodes).toBe(1);
    expect(body.unhealthyNodes).toBe(1);
    expect(body.unavailableNodes).toBe(0);
    expect(body.totalCapacityBytes).toBe(300_000_000);
    expect(body.usedCapacityBytes).toBe(75_000_000);
    expect(body.storedChunkCount).toBe(1);
    expect(body.activeReplicaCount).toBe(1);
    // 1 chunk stored, but only 1 active replica on a healthy node (< 2) -> under-replicated
    expect(body.underReplicatedChunkCount).toBe(1);
  });

  it('exposes sanitized nodes metrics without secrets or filesystem paths', async () => {
    database = new MetadataDatabase();
    database.registerStorageNode({
      nodeId: 'node-pc-b',
      endpointUrl: 'http://192.168.1.50:9001',
      status: 'HEALTHY',
      totalCapacityBytes: 500_000_000,
      usedCapacityBytes: 100_000_000,
      activeOperations: 2,
    });

    app = buildApiServer(database);

    const res = await app.inject({
      method: 'GET',
      url: '/api/cluster/nodes',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nodes).toHaveLength(1);
    const node = body.nodes[0];
    expect(node.nodeId).toBe('node-pc-b');
    expect(node.status).toBe('HEALTHY');
    expect(node.totalCapacityBytes).toBe(500_000_000);
    expect(node.usedCapacityBytes).toBe(100_000_000);
    expect(node.activeOperations).toBe(2);
    expect(typeof node.lastHeartbeatAgeMs).toBe('number');
    expect(node.storedChunkCount).toBe(0);
    expect(node.replicaCount).toBe(0);

    // Verify sanitized: no secret, no disk paths
    expect((node as Record<string, unknown>).clusterSecret).toBeUndefined();
    expect((node as Record<string, unknown>).dataDir).toBeUndefined();
    expect((node as Record<string, unknown>).storagePath).toBeUndefined();
  });

  it('exposes sanitized transfer list without capability tokens or hashes', async () => {
    database = new MetadataDatabase();
    database.registerStorageNode({
      nodeId: 'node-pc-b',
      endpointUrl: 'http://192.168.1.50:9001',
      status: 'HEALTHY',
    });
    database.registerStorageNode({
      nodeId: 'node-pc-c',
      endpointUrl: 'http://192.168.1.51:9002',
      status: 'HEALTHY',
    });

    const t1 = database.createTransfer({
      authToken: '1111111111111111111111111111111111111111111111111111111111111111',
      totalSizeBytes: 1024,
      chunkCount: 1,
      chunkSizeBytes: 1024,
      encryptedFileName: null,
      ttlSeconds: 600,
      maxDownloads: 2,
    });

    const chk1 = database.recordStoredChunk(t1.fileId, 0, {
      sizeBytes: 1024,
      checksumSha256: 'hash1',
    });
    database.recordConfirmedReplicas(chk1.chunkId, ['node-pc-b', 'node-pc-c']);

    app = buildApiServer(database);

    const res = await app.inject({
      method: 'GET',
      url: '/api/cluster/transfers?limit=10',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transfers).toHaveLength(1);
    const item = body.transfers[0];
    expect(item.fileId).toBe(t1.fileId);
    expect(item.chunkCount).toBe(1);
    expect(item.totalSizeBytes).toBe(1024);
    expect(item.maxDownloads).toBe(2);
    expect(item.isDegraded).toBe(false);

    // Sanity check: NO tokens or capability hashes leaked
    expect((item as Record<string, unknown>).capabilityHash).toBeUndefined();
    expect((item as Record<string, unknown>).capability_hash).toBeUndefined();
    expect((item as Record<string, unknown>).uploadSessionHash).toBeUndefined();
    expect((item as Record<string, unknown>).upload_session_hash).toBeUndefined();
    expect((item as Record<string, unknown>).downloadToken).toBeUndefined();
  });

  it('exposes chunk replication inspection and returns 404 for missing transfer', async () => {
    database = new MetadataDatabase();
    database.registerStorageNode({
      nodeId: 'node-pc-b',
      endpointUrl: 'http://192.168.1.50:9001',
      status: 'HEALTHY',
    });
    database.registerStorageNode({
      nodeId: 'node-pc-c',
      endpointUrl: 'http://192.168.1.51:9002',
      status: 'UNAVAILABLE',
      heartbeatAt: '1970-01-01T00:00:00.000Z',
    });

    const t = database.createTransfer({
      authToken: '2222222222222222222222222222222222222222222222222222222222222222',
      totalSizeBytes: 4096,
      chunkCount: 2,
      chunkSizeBytes: 2048,
      encryptedFileName: null,
      ttlSeconds: 600,
      maxDownloads: 1,
    });

    const chk0 = database.recordStoredChunk(t.fileId, 0, {
      sizeBytes: 2048,
      checksumSha256: 'hash-chunk-0',
    });
    database.recordConfirmedReplicas(chk0.chunkId, ['node-pc-b', 'node-pc-c']);

    const chk1 = database.recordStoredChunk(t.fileId, 1, {
      sizeBytes: 2048,
      checksumSha256: 'hash-chunk-1',
    });
    database.recordConfirmedReplicas(chk1.chunkId, ['node-pc-b']);

    app = buildApiServer(database);

    const res = await app.inject({
      method: 'GET',
      url: `/api/cluster/transfers/${t.fileId}/chunks`,
    });

    expect(res.statusCode).toBe(200);
    const detail = res.json();
    expect(detail.fileId).toBe(t.fileId);
    expect(detail.chunkCount).toBe(2);
    expect(detail.chunks).toHaveLength(2);

    const firstChunk = detail.chunks[0];
    expect(firstChunk.chunkIndex).toBe(0);
    expect(firstChunk.status).toBe('STORED');
    expect(firstChunk.expectedReplicaCount).toBe(2);
    // 1 active replica on HEALTHY node, 1 active replica on UNAVAILABLE node -> activeReplicaCount = 1
    expect(firstChunk.activeReplicaCount).toBe(1);
    expect(firstChunk.replicas).toEqual([
      { nodeId: 'node-pc-b', status: 'ACTIVE', nodeStatus: 'HEALTHY' },
      { nodeId: 'node-pc-c', status: 'ACTIVE', nodeStatus: 'UNAVAILABLE' },
    ]);

    const notFoundRes = await app.inject({
      method: 'GET',
      url: '/api/cluster/transfers/non-existent-file-id/chunks',
    });
    expect(notFoundRes.statusCode).toBe(404);
  });

  it('exposes cluster events with pagination and parsed details', async () => {
    database = new MetadataDatabase();
    const e1 = database.recordClusterEvent({
      eventType: 'NODE_HEARTBEAT_REJECTED',
      severity: 'WARN',
      nodeId: 'unknown-node',
      details: { reason: 'UNAUTHORIZED', ip: '192.168.1.99' },
    });
    const e2 = database.recordClusterEvent({
      eventType: 'FAILOVER_READ',
      severity: 'INFO',
      nodeId: 'node-pc-c',
      details: { fromNode: 'node-pc-b', chunkId: 'chk-123' },
    });

    app = buildApiServer(database);

    const res = await app.inject({
      method: 'GET',
      url: '/api/cluster/events?limit=10',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events.length).toBeGreaterThanOrEqual(2);

    const failoverEvent = body.events.find((e: { eventType: string }) => e.eventType === 'FAILOVER_READ');
    expect(failoverEvent).toBeDefined();
    expect(failoverEvent.nodeId).toBe('node-pc-c');
    expect(failoverEvent.details).toEqual({ fromNode: 'node-pc-b', chunkId: 'chk-123' });

    // Test afterId filter
    const afterRes = await app.inject({
      method: 'GET',
      url: `/api/cluster/events?afterId=${e1.id}`,
    });
    expect(afterRes.statusCode).toBe(200);
    const afterBody = afterRes.json();
    // e2 was inserted after e1, so it should be included
    expect(afterBody.events.some((e: { id: string }) => e.id === e2.id)).toBe(true);
    // e1 itself should not be returned since it was before
    expect(afterBody.events.some((e: { id: string }) => e.id === e1.id)).toBe(false);
  });
});
