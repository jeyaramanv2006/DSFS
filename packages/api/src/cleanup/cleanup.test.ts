import { describe, expect, it } from 'vitest';
import { MetadataDatabase } from '../db/database.js';
import { ExpirationSweeper, StorageReconciler, type CleanupTarget, type ReconciliationTarget } from './cleanup.js';

class MemoryMaintenanceNode {
  public readonly chunks = new Set<string>();
  public constructor(private readonly failDeletes = false) {}

  public async deleteChunk(chunkId: string): Promise<boolean> {
    if (this.failDeletes) throw new Error('node unavailable');
    this.chunks.delete(chunkId);
    return true;
  }

  public async listChunks(): Promise<string[]> {
    return [...this.chunks].sort();
  }
}

function createExpiredTransfer(database: MetadataDatabase): { fileId: string; chunkId: string } {
  const transfer = database.createTransfer({
    authToken: 'cc'.repeat(32), totalSizeBytes: 1, chunkCount: 1,
    chunkSizeBytes: 1, encryptedFileName: null, ttlSeconds: 600, maxDownloads: 1,
  });
  const chunkId = `${transfer.fileId}-0`;
  database.db.prepare(`UPDATE transfers SET status = 'READY', expires_at = '2026-10-07T09:00:00.000Z' WHERE file_id = ?`).run(transfer.fileId);
  database.db.prepare(`INSERT INTO chunks (chunk_id, file_id, chunk_index, size_bytes, checksum_sha256, status) VALUES (?, ?, 0, 1, ?, 'STORED')`).run(chunkId, transfer.fileId, 'a'.repeat(64));
  return { fileId: transfer.fileId, chunkId };
}

describe('expiration sweeper and storage reconciliation', () => {
  it('deletes all replicas and marks metadata deleted', async () => {
    const database = new MetadataDatabase();
    const nodeA = new MemoryMaintenanceNode();
    const nodeB = new MemoryMaintenanceNode();
    database.registerStorageNode({ nodeId: 'node-a', endpointUrl: 'http://node-a', status: 'HEALTHY' });
    database.registerStorageNode({ nodeId: 'node-b', endpointUrl: 'http://node-b', status: 'HEALTHY' });
    const { fileId, chunkId } = createExpiredTransfer(database);
    database.recordConfirmedReplicas(chunkId, ['node-a', 'node-b']);
    nodeA.chunks.add(chunkId);
    nodeB.chunks.add(chunkId);
    const targets: CleanupTarget[] = [
      { nodeId: 'node-a', client: nodeA },
      { nodeId: 'node-b', client: nodeB },
    ];
    const report = await new ExpirationSweeper(database, targets).sweep(new Date('2026-10-07T10:00:00.000Z'));
    expect(report).toEqual({ claimedTransfers: [fileId], deletedTransfers: [fileId], orphanedReplicas: [] });
    expect(nodeA.chunks.size).toBe(0);
    expect(nodeB.chunks.size).toBe(0);
    expect(database.getTransfer(fileId)?.status).toBe('DELETED');
    database.close();
  });

  it('retains a failed node delete as retryable orphan-pending state', async () => {
    const database = new MetadataDatabase();
    const failingNode = new MemoryMaintenanceNode(true);
    database.registerStorageNode({ nodeId: 'node-a', endpointUrl: 'http://node-a', status: 'UNAVAILABLE' });
    const { fileId, chunkId } = createExpiredTransfer(database);
    database.recordConfirmedReplicas(chunkId, ['node-a']);
    const report = await new ExpirationSweeper(database, [{ nodeId: 'node-a', client: failingNode }]).sweep(new Date('2026-10-07T10:00:00.000Z'));
    expect(report.deletedTransfers).toEqual([]);
    expect(report.orphanedReplicas).toEqual([{ chunkId, nodeId: 'node-a' }]);
    expect(database.getConfirmedReplicas(chunkId)).toEqual([{ node_id: 'node-a', status: 'ORPHANED_PENDING_DELETE' }]);
    expect(database.getTransfer(fileId)?.status).toBe('DELETING');
    database.close();
  });

  it('removes returned-node orphan files while preserving active catalog chunks', async () => {
    const database = new MetadataDatabase();
    const node = new MemoryMaintenanceNode();
    database.registerStorageNode({ nodeId: 'node-a', endpointUrl: 'http://node-a', status: 'HEALTHY' });
    const active = createExpiredTransfer(database);
    database.db.prepare("UPDATE transfers SET status = 'READY', expires_at = '2026-12-31T00:00:00.000Z' WHERE file_id = ?").run(active.fileId);
    database.recordConfirmedReplicas(active.chunkId, ['node-a']);
    const orphan = 'orphan-chunk';
    node.chunks.add(active.chunkId);
    node.chunks.add(orphan);
    const targets: ReconciliationTarget[] = [{ nodeId: 'node-a', client: node }];
    const report = await new StorageReconciler(database, targets).reconcile();
    expect(report).toEqual({ deletedOrphans: [{ nodeId: 'node-a', chunkId: orphan }], failedDeletes: [] });
    expect(await node.listChunks()).toEqual([active.chunkId]);
    database.close();
  });
});
