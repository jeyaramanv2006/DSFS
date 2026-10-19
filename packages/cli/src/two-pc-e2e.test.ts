import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { MetadataDatabase } from '../../api/src/db/database.js';
import { buildApiServer } from '../../api/src/server.js';
import { PlacementService } from '../../api/src/placement/service.js';
import { ReplicationService } from '../../api/src/replication/replication.js';
import { ReplicaReadService } from '../../api/src/replication/read-service.js';
import { HttpStorageNodeClient } from '../../api/src/services/storage-client.js';
import { HealthMonitor } from '../../api/src/health/monitor.js';
import { ExpirationSweeper } from '../../api/src/cleanup/cleanup.js';
import { buildServer as buildStorageNodeServer } from '../../storage-node/src/server.js';
import type { ChunkWriteResult, IStorageNode, NodeHealthReport } from '../../storage-node/src/storage.js';
import { downloadBytes, downloadByCode, resolveTransfer, uploadBytes } from './client.js';

const CLUSTER_SECRET = 'cluster-secret-3pc-demo-e2e';

class MemoryStorageNode implements IStorageNode {
  public readonly chunks = new Map<string, Buffer>();
  public activeOperations = 0;

  public constructor(
    public readonly nodeId: string,
    public readonly totalCapacityBytes = 100_000_000,
  ) {}

  public async putChunk(
    chunkId: string,
    input: NodeJS.ReadableStream,
    expectedChecksum: string,
  ): Promise<ChunkWriteResult> {
    const parts: Buffer[] = [];
    for await (const part of input as AsyncIterable<Buffer | string>) {
      parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
    }
    const body = Buffer.concat(parts);
    const checksum = createHash('sha256').update(body).digest('hex');
    if (checksum !== expectedChecksum) throw new Error('checksum mismatch');
    this.chunks.set(chunkId, body);
    return { sizeBytes: body.length, checksumSha256: checksum };
  }

  public async getChunk(chunkId: string): Promise<Readable> {
    const body = this.chunks.get(chunkId);
    if (!body) throw new Error('chunk not found');
    return Readable.from(Buffer.from(body));
  }

  public async deleteChunk(chunkId: string): Promise<boolean> {
    return this.chunks.delete(chunkId);
  }

  public async hasChunk(chunkId: string): Promise<boolean> {
    return this.chunks.has(chunkId);
  }

  public async listChunks(): Promise<string[]> {
    return [...this.chunks.keys()];
  }

  public async healthCheck(): Promise<NodeHealthReport> {
    let used = 0;
    for (const buf of this.chunks.values()) used += buf.length;
    return {
      nodeId: this.nodeId,
      status: 'HEALTHY',
      totalCapacityBytes: this.totalCapacityBytes,
      usedCapacityBytes: used,
      activeOperations: this.activeOperations,
    };
  }

  public async reconcile(): Promise<number> {
    return this.chunks.size;
  }
}

describe('Three-PC Topology End-to-End Test (Coordinator + PC B + PC C)', () => {
  let coordinatorApp: Awaited<ReturnType<typeof buildApiServer>> | undefined;
  let nodeBApp: Awaited<ReturnType<typeof buildStorageNodeServer>> | undefined;
  let nodeCApp: Awaited<ReturnType<typeof buildStorageNodeServer>> | undefined;
  let database: MetadataDatabase | undefined;
  let monitor: HealthMonitor | undefined;

  afterEach(async () => {
    monitor?.stop();
    await coordinatorApp?.close();
    await nodeBApp?.close();
    await nodeCApp?.close();
    database?.close();
  });

  it('verifies multi-chunk upload, dual-PC replication, code retrieval, failover on node outage, and quota purge', async () => {
    // 1. Start PC B Storage Node (node-1) over real HTTP
    const storeB = new MemoryStorageNode('node-1');
    nodeBApp = buildStorageNodeServer(storeB, { clusterSecret: CLUSTER_SECRET });
    await nodeBApp.listen({ host: '127.0.0.1', port: 0 });
    const addrB = nodeBApp.server.address();
    if (!addrB || typeof addrB === 'string') throw new Error('nodeB did not bind');
    const portB = addrB.port;
    const urlB = `http://127.0.0.1:${portB}`;

    // 2. Start PC C Storage Node (node-2) over real HTTP
    const storeC = new MemoryStorageNode('node-2');
    nodeCApp = buildStorageNodeServer(storeC, { clusterSecret: CLUSTER_SECRET });
    await nodeCApp.listen({ host: '127.0.0.1', port: 0 });
    const addrC = nodeCApp.server.address();
    if (!addrC || typeof addrC === 'string') throw new Error('nodeC did not bind');
    const urlC = `http://127.0.0.1:${addrC.port}`;

    // 3. Start PC A Coordinator API server over real HTTP
    database = new MetadataDatabase();
    database.registerStorageNode({ nodeId: 'node-1', endpointUrl: urlB, status: 'UNAVAILABLE' });
    database.registerStorageNode({ nodeId: 'node-2', endpointUrl: urlC, status: 'UNAVAILABLE' });

    const nodeTargets = [
      { nodeId: 'node-1', client: new HttpStorageNodeClient(urlB, CLUSTER_SECRET) },
      { nodeId: 'node-2', client: new HttpStorageNodeClient(urlC, CLUSTER_SECRET) },
    ];

    const replicator = new ReplicationService(
      database,
      new PlacementService(database),
      nodeTargets,
    );
    const readService = new ReplicaReadService(database, nodeTargets);
    let simulatedTime = new Date('2026-10-20T10:00:00.000Z');
    monitor = new HealthMonitor(
      database,
      () => simulatedTime,
      { unhealthyAfterMs: 5000, unavailableAfterMs: 10000 },
    );

    coordinatorApp = buildApiServer(
      database,
      nodeTargets[0].client,
      replicator,
      readService,
      monitor,
      {
        clusterSecret: CLUSTER_SECRET,
        allowedNodeIds: ['node-1', 'node-2'],
      },
    );
    await coordinatorApp.listen({ host: '127.0.0.1', port: 0 });
    const addrA = coordinatorApp.server.address();
    if (!addrA || typeof addrA === 'string') throw new Error('coordinator did not bind');
    const coordinatorUrl = `http://127.0.0.1:${addrA.port}`;

    // 4. Send authenticated heartbeats from PC B and PC C to PC A
    monitor.recordHeartbeat({
      nodeId: 'node-1',
      endpointUrl: urlB,
      totalCapacityBytes: 100_000_000,
      usedCapacityBytes: 0,
      activeOperations: 0,
    });
    monitor.recordHeartbeat({
      nodeId: 'node-2',
      endpointUrl: urlC,
      totalCapacityBytes: 100_000_000,
      usedCapacityBytes: 0,
      activeOperations: 0,
    });

    expect(database.getStorageNode('node-1')?.status).toBe('HEALTHY');
    expect(database.getStorageNode('node-2')?.status).toBe('HEALTHY');

    // 5. Client uploads a multi-chunk file (3 chunks, 32 bytes each)
    const originalPlaintext = new Uint8Array(randomBytes(80)); // 32 + 32 + 16 = 3 chunks
    const uploaded = await uploadBytes(coordinatorUrl, originalPlaintext, {
      fileName: 'confidential-report.pdf',
      chunkSizeBytes: 32,
      maxDownloads: 2, // Allow 2 downloads before auto-consumption
    });

    expect(uploaded.fileId).toMatch(/^[a-f0-9]{32}$/);
    expect(uploaded.retrievalCode).toHaveLength(43);

    // 6. Confirm on-disk replication to BOTH PC B and PC C
    expect(storeB.chunks.size).toBe(3);
    expect(storeC.chunks.size).toBe(3);
    expect([...storeB.chunks.keys()].sort()).toEqual([
      `${uploaded.fileId}-0`,
      `${uploaded.fileId}-1`,
      `${uploaded.fileId}-2`,
    ]);
    expect([...storeC.chunks.keys()].sort()).toEqual([
      `${uploaded.fileId}-0`,
      `${uploaded.fileId}-1`,
      `${uploaded.fileId}-2`,
    ]);

    // Verify cluster overview API
    const overview = database.getClusterOverview();
    expect(overview.totalNodes).toBe(2);
    expect(overview.healthyNodes).toBe(2);
    expect(overview.storedChunkCount).toBe(3);
    expect(overview.activeReplicaCount).toBe(6); // 3 chunks x 2 replicas
    expect(overview.underReplicatedChunkCount).toBe(0);

    // 7. Verify pre-download metadata preview by retrieval code
    const preview = await resolveTransfer(coordinatorUrl, uploaded.retrievalCode);
    expect(preview.fileId).toBe(uploaded.fileId);
    expect(preview.status).toBe('READY');
    expect(preview.chunkCount).toBe(3);
    expect(preview.downloadCount).toBe(0);
    expect(preview.maxDownloads).toBe(2);

    // 8. Download 1: Retrieve by 43-character retrieval code
    const downloaded1 = await downloadByCode(coordinatorUrl, uploaded.retrievalCode);
    expect(downloaded1).toEqual(originalPlaintext);

    // After 1st download, download_count is 1, transfer remains READY
    const transferAfterFirst = database.getTransfer(uploaded.fileId);
    expect(transferAfterFirst?.download_count).toBe(1);
    expect(transferAfterFirst?.status).toBe('READY');

    // 9. Simulate PC B Outage: Stop PC B process
    await nodeBApp.close();
    nodeBApp = undefined;

    // 10. Download 2: Retrieve during PC B outage via share link
    // The coordinator attempts node-1, gets connection refused, seamlessly fails over to node-2, and returns all chunks!
    const downloaded2 = await downloadBytes(coordinatorUrl, uploaded.fileId, uploaded.secret);
    expect(downloaded2).toEqual(originalPlaintext);

    // Check that read failover was recorded in the database
    const failoverEvents = database.listClusterEvents({ eventType: 'READ_FAILOVER_SUCCEEDED' });
    expect(failoverEvents.length).toBeGreaterThanOrEqual(1);
    expect(failoverEvents[0].node_id).toBe('node-2');

    // 11. Now advance monitor clock past unavailable threshold -> status updates to UNAVAILABLE
    simulatedTime = new Date('2026-10-20T10:00:15.000Z'); // 15 seconds later (> 10s unavailable threshold)
    const transitions = monitor.refresh();
    expect(transitions).toContainEqual({
      nodeId: 'node-1',
      previous: 'HEALTHY',
      current: 'UNAVAILABLE',
    });
    expect(database.getStorageNode('node-1')?.status).toBe('UNAVAILABLE');

    // 11. Quota Exhaustion: max_downloads (2) reached -> status becomes CONSUMED
    const transferAfterSecond = database.getTransfer(uploaded.fileId);
    expect(transferAfterSecond?.download_count).toBe(2);
    expect(transferAfterSecond?.status).toBe('CONSUMED');

    // 12. Subsequent download attempt is rejected with 410 GONE
    await expect(downloadByCode(coordinatorUrl, uploaded.retrievalCode))
      .rejects.toThrow('VoidShare API request failed with 410');

    // 13. Expiration sweeper runs while PC B is offline: deletes PC C replicas
    // PC B replicas fail and are marked orphaned pending delete; transfer remains DELETING
    const partialSweeper = new ExpirationSweeper(database, [nodeTargets[1]]);
    const partialResult = await partialSweeper.sweep();
    expect(partialResult.claimedTransfers).toEqual([uploaded.fileId]);
    expect(partialResult.deletedTransfers).toEqual([]); // Transfer deletion cannot finalize while PC B replicas exist
    expect(partialResult.orphanedReplicas).toHaveLength(3); // 3 replicas on offline PC B
    expect(storeC.chunks.size).toBe(0); // All chunks purged from PC C
    expect(database.getTransfer(uploaded.fileId)?.status).toBe('DELETING');

    // 14. PC B recovers and reconnects: sweeper cleans up PC B replicas and finalizes deletion
    nodeBApp = buildStorageNodeServer(storeB, { clusterSecret: CLUSTER_SECRET });
    await nodeBApp.listen({ host: '127.0.0.1', port: portB });
    try {
      const fullSweeper = new ExpirationSweeper(database, nodeTargets);
      const fullResult = await fullSweeper.sweep();
      expect(fullResult.deletedTransfers).toEqual([uploaded.fileId]);
      expect(storeB.chunks.size).toBe(0); // All chunks purged from PC B
      expect(database.getTransfer(uploaded.fileId)?.status).toBe('DELETED');
    } finally {
      await nodeBApp.close();
      nodeBApp = undefined;
    }
  });
});

