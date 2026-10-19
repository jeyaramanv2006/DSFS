import { describe, expect, it } from 'vitest';
import { MetadataDatabase } from '../db/database.js';
import { ExpirationSweeper, StorageReconciler } from '../cleanup/cleanup.js';
import { RecoveryService } from '../recovery/recovery.js';
import { BackgroundWorkerManager } from './manager.js';

describe('BackgroundWorkerManager', () => {
  it('manages timer lifecycles correctly', () => {
    const database = new MetadataDatabase();
    const sweeper = new ExpirationSweeper(database, []);
    const reconciler = new StorageReconciler(database, []);
    const recovery = new RecoveryService(database, []);

    const manager = new BackgroundWorkerManager(database, sweeper, reconciler, recovery, {
      expirationSweepIntervalMs: 100,
      reconciliationIntervalMs: 200,
      recoveryIntervalMs: 200,
    });

    expect(manager.isStarted()).toBe(false);
    manager.start();
    expect(manager.isStarted()).toBe(true);

    // Idempotent start
    manager.start();
    expect(manager.isStarted()).toBe(true);

    manager.stop();
    expect(manager.isStarted()).toBe(false);
    database.close();
  });

  it('runs sweep and logs SWEEP_COMPLETED event when transfers are claimed and deleted', async () => {
    const database = new MetadataDatabase();
    const authToken = '77'.repeat(32);
    const created = database.createTransfer({
      authToken,
      totalSizeBytes: 10,
      chunkCount: 1,
      chunkSizeBytes: 10,
      encryptedFileName: null,
      ttlSeconds: 600,
      maxDownloads: 1,
    });
    // Mark expired
    database.db.prepare("UPDATE transfers SET status = 'READY', expires_at = '2020-01-01T00:00:00.000Z' WHERE file_id = ?")
      .run(created.fileId);

    const deletedNodes: string[] = [];
    const targets = [
      {
        nodeId: 'node-1',
        client: {
          deleteChunk: async (id: string) => {
            deletedNodes.push(id);
            return true;
          },
        },
      },
    ];

    const sweeper = new ExpirationSweeper(database, targets);
    const reconciler = new StorageReconciler(database, []);
    const recovery = new RecoveryService(database, []);

    const manager = new BackgroundWorkerManager(database, sweeper, reconciler, recovery);
    const report = await manager.runSweep();

    expect(report?.claimedTransfers).toContain(created.fileId);
    expect(report?.deletedTransfers).toContain(created.fileId);

    const events = database.listClusterEvents({ eventType: 'SWEEP_COMPLETED' });
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe('INFO');

    database.close();
  });

  it('runs recovery and records RECOVERY_COMPLETED event on recovered chunks', async () => {
    const database = new MetadataDatabase();
    database.registerStorageNode({ nodeId: 'node-a', endpointUrl: 'http://a', status: 'HEALTHY' });
    database.registerStorageNode({ nodeId: 'node-b', endpointUrl: 'http://b', status: 'HEALTHY' });

    const created = database.createTransfer({
      authToken: '88'.repeat(32),
      totalSizeBytes: 4,
      chunkCount: 1,
      chunkSizeBytes: 4,
      encryptedFileName: null,
      ttlSeconds: 600,
      maxDownloads: 1,
    });
    const chunkId = `${created.fileId}-0`;
    database.db.prepare("INSERT INTO chunks (chunk_id, file_id, chunk_index, size_bytes, checksum_sha256, status) VALUES (?, ?, 0, 4, '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', 'STORED')")
      .run(chunkId, created.fileId);
    // Only node-a has replica (under-replicated, RF=2)
    database.recordConfirmedReplicas(chunkId, ['node-a']);

    const targets = [
      {
        nodeId: 'node-a',
        client: {
          getChunk: async () => (await import('node:stream')).Readable.from(Buffer.from('test')),
          putChunk: async () => ({ sizeBytes: 4, checksumSha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' }),
        },
      },
      {
        nodeId: 'node-b',
        client: {
          getChunk: async () => (await import('node:stream')).Readable.from(Buffer.from('test')),
          putChunk: async () => ({ sizeBytes: 4, checksumSha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' }),
        },
      },
    ];

    const sweeper = new ExpirationSweeper(database, []);
    const reconciler = new StorageReconciler(database, []);
    const recovery = new RecoveryService(database, targets, 2);

    const manager = new BackgroundWorkerManager(database, sweeper, reconciler, recovery);
    const report = await manager.runRecovery();

    expect(report?.recovered).toHaveLength(1);
    expect(report?.recovered[0]).toEqual({
      chunkId,
      sourceNodeId: 'node-a',
      targetNodeId: 'node-b',
    });

    const events = database.listClusterEvents({ eventType: 'RECOVERY_COMPLETED' });
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe('INFO');

    database.close();
  });
});
