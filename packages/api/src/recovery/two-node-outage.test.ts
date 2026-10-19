import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MetadataDatabase } from '../db/database.js';
import { PlacementService } from '../placement/service.js';
import { ReplicationService } from '../replication/replication.js';
import { ReplicaReadService } from '../replication/read-service.js';
import { HealthMonitor } from '../health/monitor.js';
import { ExpirationSweeper, StorageReconciler } from '../cleanup/cleanup.js';
import { RecoveryService } from '../recovery/recovery.js';
import type { StorageNodeClient, StoredChunkResult } from '../services/storage-client.js';

class MockStorageNode implements StorageNodeClient {
  public isOnline = true;
  public storage = new Map<string, Buffer>();
  public deleteCalls: string[] = [];

  public constructor(public readonly nodeId: string) {}

  public async putChunk(
    chunkId: string,
    input: NodeJS.ReadableStream,
    checksumSha256: string,
  ): Promise<StoredChunkResult> {
    if (!this.isOnline) throw new Error(`Node ${this.nodeId} is offline`);
    const parts: Buffer[] = [];
    for await (const chunk of input as AsyncIterable<Buffer>) {
      parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buf = Buffer.concat(parts);
    this.storage.set(chunkId, buf);
    return { sizeBytes: buf.length, checksumSha256 };
  }

  public async getChunk(chunkId: string): Promise<Readable> {
    if (!this.isOnline) throw new Error(`Node ${this.nodeId} is offline`);
    const buf = this.storage.get(chunkId);
    if (!buf) throw new Error(`Chunk ${chunkId} not found on ${this.nodeId}`);
    return Readable.from(Buffer.from(buf));
  }

  public async deleteChunk(chunkId: string): Promise<boolean> {
    this.deleteCalls.push(chunkId);
    if (!this.isOnline) throw new Error(`Node ${this.nodeId} is offline`);
    return this.storage.delete(chunkId);
  }

  public async listChunks(): Promise<string[]> {
    if (!this.isOnline) throw new Error(`Node ${this.nodeId} is offline`);
    return [...this.storage.keys()];
  }
}

describe('two-node physical cluster outage, failover, and durability lifecycle', () => {
  it('manages 2-node replication, read failover on outage, RF=2 constraint, and multi-replica deletion', async () => {
    const database = new MetadataDatabase();

    // 1. Register two nodes (PC B: node-1, PC C: node-2)
    const node1 = new MockStorageNode('node-1');
    const node2 = new MockStorageNode('node-2');
    const targets = [
      { nodeId: 'node-1', client: node1 },
      { nodeId: 'node-2', client: node2 },
    ];

    let clockTime = new Date();
    const monitor = new HealthMonitor(database, () => clockTime, {
      unhealthyAfterMs: 5000,
      unavailableAfterMs: 10000,
    });

    monitor.recordHeartbeat({ nodeId: 'node-1', endpointUrl: 'http://node-1:9001', totalCapacityBytes: 10000, usedCapacityBytes: 0, activeOperations: 0 });
    monitor.recordHeartbeat({ nodeId: 'node-2', endpointUrl: 'http://node-2:9002', totalCapacityBytes: 10000, usedCapacityBytes: 0, activeOperations: 0 });

    const placement = new PlacementService(database, 32);
    const replicator = new ReplicationService(database, placement, targets);
    const readService = new ReplicaReadService(database, targets);
    const sweeper = new ExpirationSweeper(database, targets);
    const reconciler = new StorageReconciler(database, targets);
    const recovery = new RecoveryService(database, targets, 2);

    // 2. Upload file with 1 chunk
    const authToken = 'aa'.repeat(32);
    const payload = Buffer.from('important distributed data');
    const checksum = createHash('sha256').update(payload).digest('hex');

    const created = database.createTransfer({
      authToken,
      totalSizeBytes: payload.length,
      chunkCount: 1,
      chunkSizeBytes: payload.length,
      encryptedFileName: 'secrets.txt',
      ttlSeconds: 600,
      maxDownloads: 1,
    });
    const chunkId = `${created.fileId}-0`;

    // Record pending chunk and replicate chunk (RF=2)
    database.recordPendingChunk(created.fileId, 0, { sizeBytes: payload.length, checksumSha256: checksum });
    const replResult = await replicator.replicateChunk(chunkId, payload, checksum, 2);
    expect(replResult.confirmedNodeIds).toEqual(expect.arrayContaining(['node-1', 'node-2']));
    expect(node1.storage.has(chunkId)).toBe(true);
    expect(node2.storage.has(chunkId)).toBe(true);

    database.markStoredChunk(created.fileId, 0, { sizeBytes: payload.length, checksumSha256: checksum });
    const readyTransfer = database.finalizeTransfer(created.fileId);
    expect(readyTransfer?.status).toBe('READY');

    // 3. Outage: crash the primary replica node for this chunk
    const confirmedReplicas = database.getConfirmedReplicas(chunkId).map((r) => r.node_id);
    const primaryNodeId = confirmedReplicas[0];
    const secondaryNodeId = confirmedReplicas[1];
    const primaryNode = primaryNodeId === 'node-1' ? node1 : node2;
    const secondaryNode = primaryNodeId === 'node-1' ? node2 : node1;

    primaryNode.isOnline = false;

    // 4. Reactive read failover: before monitor detects outage, read attempts primaryNode,
    // fails, and seamlessly fails over to secondaryNode without failing user
    const downloadStream = await readService.getChunk(chunkId);
    const parts: Buffer[] = [];
    for await (const chunk of downloadStream) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const downloaded = Buffer.concat(parts);
    expect(downloaded.toString('utf8')).toBe('important distributed data');
    expect(createHash('sha256').update(downloaded).digest('hex')).toBe(checksum);

    // Failover event was logged in SQLite
    const failoverEvents = database.listClusterEvents({ eventType: 'READ_FAILOVER_SUCCEEDED' });
    expect(failoverEvents.length).toBeGreaterThanOrEqual(1);
    expect(failoverEvents[0].node_id).toBe(secondaryNodeId);
    expect(failoverEvents[0].details).toContain(primaryNodeId);

    // 5. Monitor detects outage after heartbeat threshold
    clockTime = new Date(clockTime.getTime() + 15_000);
    monitor.refresh();
    expect(database.getStorageNode(primaryNodeId)?.status).toBe('UNAVAILABLE');

    // Subsequent read proactively prefers HEALTHY secondaryNode directly
    const directStream = await readService.getChunk(chunkId);
    const directParts: Buffer[] = [];
    for await (const chunk of directStream) directParts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    expect(Buffer.concat(directParts).toString('utf8')).toBe('important distributed data');

    // 5. RF=2 Constraint Truthfulness: while one node is down, recovery CANNOT fabricate a 3rd node
    const recoveryReport = await recovery.recoverUnderReplicated();
    // Candidate cannot be recovered because no 3rd healthy node exists
    expect(recoveryReport.recovered).toHaveLength(0);
    expect(recoveryReport.skipped).toContain(chunkId);

    // 6. Restoration: primaryNode recovers and rejoins the cluster
    primaryNode.isOnline = true;
    clockTime = new Date(clockTime.getTime() + 5_000);
    monitor.recordHeartbeat({
      nodeId: primaryNodeId,
      endpointUrl: `http://${primaryNodeId}:9001`,
      totalCapacityBytes: 10000,
      usedCapacityBytes: payload.length,
      activeOperations: 0,
    });
    expect(database.getStorageNode(primaryNodeId)?.status).toBe('HEALTHY');

    const recoveredEvents = database.listClusterEvents({ eventType: 'NODE_RECOVERED', nodeId: primaryNodeId });
    expect(recoveredEvents.length).toBeGreaterThanOrEqual(1);

    // Reconciler verifies data on both nodes
    const reconReport = await reconciler.reconcile();
    expect(reconReport.deletedOrphans).toHaveLength(0);

    // 7. Multi-replica deletion on transfer consumption
    const lease = database.acquireDownloadLease(created.fileId, createHash('sha256').update(Buffer.from(authToken, 'hex')).digest('hex'), clockTime);
    expect(lease).toBeDefined();

    database.completeDownload(created.fileId, createHash('sha256').update(Buffer.from(lease!.downloadToken, 'hex')).digest('hex'), clockTime);
    expect(database.getTransfer(created.fileId)?.status).toBe('CONSUMED');

    // Run expiration sweeper
    const sweepReport = await sweeper.sweep(clockTime);
    expect(sweepReport.claimedTransfers).toContain(created.fileId);
    expect(sweepReport.deletedTransfers).toContain(created.fileId);

    // Assert that the chunk was deleted from BOTH node-1 AND node-2
    expect(node1.storage.has(chunkId)).toBe(false);
    expect(node2.storage.has(chunkId)).toBe(false);
    expect(node1.deleteCalls).toContain(chunkId);
    expect(node2.deleteCalls).toContain(chunkId);

    database.close();
  });
});
