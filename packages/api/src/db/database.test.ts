import { describe, expect, it } from 'vitest';
import { MetadataDatabase } from './database.js';
import { hashToken } from '../services/tokens.js';

describe('metadata database migrations', () => {
  it('creates the coordination schema and is safe to run repeatedly', () => {
    const database = new MetadataDatabase();

    expect(database.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([
      { name: 'chunk_placements' },
      { name: 'chunk_replicas' },
      { name: 'chunks' },
      { name: 'cluster_events' },
      { name: 'storage_nodes' },
      { name: 'transfers' },
    ]);
    expect(database.db.prepare('PRAGMA table_info(transfers)').all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'upload_session_hash' }),
        expect.objectContaining({ name: 'download_lease_until' }),
      ]),
    );

    database.migrate();
    expect(database.db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'").pluck().get()).toBe(6);
    database.close();
  });

  it('records and queries cluster events with filtering and limit', () => {
    const database = new MetadataDatabase();
    database.recordClusterEvent({
      eventType: 'NODE_REGISTERED',
      severity: 'INFO',
      nodeId: 'node-1',
      details: { endpoint: 'http://localhost:9001' },
      createdAt: '2026-10-07T10:00:00.000Z',
    });
    database.recordClusterEvent({
      eventType: 'NODE_UNHEALTHY',
      severity: 'WARN',
      nodeId: 'node-1',
      details: { ageMs: 7000 },
      createdAt: '2026-10-07T10:01:00.000Z',
    });
    database.recordClusterEvent({
      eventType: 'NODE_UNAVAILABLE',
      severity: 'ERROR',
      nodeId: 'node-2',
      details: 'Node unreachable',
      createdAt: '2026-10-07T10:02:00.000Z',
    });

    const allEvents = database.listClusterEvents();
    expect(allEvents).toHaveLength(3);
    // Ordered by created_at DESC
    expect(allEvents[0].event_type).toBe('NODE_UNAVAILABLE');
    expect(allEvents[0].severity).toBe('ERROR');
    expect(allEvents[0].node_id).toBe('node-2');
    expect(allEvents[0].details).toBe('Node unreachable');

    const node1Events = database.listClusterEvents({ nodeId: 'node-1' });
    expect(node1Events).toHaveLength(2);
    expect(node1Events[0].event_type).toBe('NODE_UNHEALTHY');

    const errorEvents = database.listClusterEvents({ eventType: 'NODE_UNAVAILABLE' });
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].node_id).toBe('node-2');

    const limited = database.listClusterEvents({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].event_type).toBe('NODE_UNAVAILABLE');

    database.close();
  });

  it('replaces an expired download lease and invalidates the previous token hash', () => {
    const database = new MetadataDatabase();
    const authToken = '33'.repeat(32);
    const created = database.createTransfer({
      authToken,
      totalSizeBytes: 1,
      chunkCount: 1,
      chunkSizeBytes: 1,
      encryptedFileName: null,
      ttlSeconds: 600,
      maxDownloads: 1,
    });
    database.db.prepare("UPDATE transfers SET status = 'READY', expires_at = '2026-12-31T00:00:00.000Z' WHERE file_id = ?").run(created.fileId);
    const first = database.acquireDownloadLease(created.fileId, hashToken(authToken), new Date('2026-10-01T00:00:00.000Z'))!;
    database.db.prepare("UPDATE transfers SET download_lease_until = '2025-12-31T23:59:00.000Z' WHERE file_id = ?").run(created.fileId);
    const second = database.acquireDownloadLease(created.fileId, hashToken(authToken), new Date('2026-10-01T00:01:00.000Z'))!;
    expect(second.downloadToken).not.toBe(first.downloadToken);
    expect(second.transfer.download_token_hash).not.toBe(hashToken(first.downloadToken));
    database.close();
  });

  it('registers storage nodes idempotently and persists ordered placement records', () => {
    const database = new MetadataDatabase();
    database.registerStorageNode({ nodeId: 'node-a', endpointUrl: 'http://localhost:9001', status: 'HEALTHY' });
    database.registerStorageNode({ nodeId: 'node-b', endpointUrl: 'http://localhost:9002', status: 'HEALTHY' });
    database.registerStorageNode({ nodeId: 'node-a', endpointUrl: 'http://localhost:9011', status: 'UNHEALTHY' });
    expect(database.listStorageNodes()).toHaveLength(2);
    expect(database.listStorageNodes('HEALTHY')).toEqual([
      expect.objectContaining({ node_id: 'node-b' }),
    ]);
    const created = database.createTransfer({
      authToken: '44'.repeat(32), totalSizeBytes: 1, chunkCount: 1,
      chunkSizeBytes: 1, encryptedFileName: null, ttlSeconds: 600, maxDownloads: 1,
    });
    database.db.prepare(`INSERT INTO chunks (chunk_id, file_id, chunk_index, size_bytes, checksum_sha256, status) VALUES (?, ?, 0, 1, ?, 'STORED')`)
      .run(`${created.fileId}-0`, created.fileId, 'a'.repeat(64));
    database.recordPlacement(`${created.fileId}-0`, ['node-b', 'node-a']);
    expect(database.getPlacement(`${created.fileId}-0`)).toEqual([
      { node_id: 'node-b', placement_rank: 0 },
      { node_id: 'node-a', placement_rank: 1 },
    ]);
    database.close();
  });

  it('allows only one concurrent lease winner and recovers an expired winner', () => {
    const database = new MetadataDatabase();
    const authToken = '66'.repeat(32);
    const created = database.createTransfer({ authToken, totalSizeBytes: 1, chunkCount: 1, chunkSizeBytes: 1, encryptedFileName: null, ttlSeconds: 600, maxDownloads: 2 });
    database.db.prepare("UPDATE transfers SET status = 'READY', expires_at = '2026-12-31T00:00:00.000Z' WHERE file_id = ?").run(created.fileId);
    const now = new Date('2026-10-07T10:00:00.000Z');
    const first = database.acquireDownloadLease(created.fileId, hashToken(authToken), now);
    const second = database.acquireDownloadLease(created.fileId, hashToken(authToken), now);
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    database.db.prepare("UPDATE transfers SET download_lease_until = '2026-10-07T09:59:00.000Z' WHERE file_id = ?").run(created.fileId);
    const recovered = database.acquireDownloadLease(created.fileId, hashToken(authToken), new Date('2026-10-07T10:01:00.000Z'));
    expect(recovered).toBeDefined();
    expect(recovered?.downloadToken).not.toBe(first?.downloadToken);
    database.close();
  });

  it('distinguishes invalid capability from a valid but gone transfer', () => {
    const database = new MetadataDatabase();
    const authToken = '77'.repeat(32);
    const created = database.createTransfer({ authToken, totalSizeBytes: 1, chunkCount: 1, chunkSizeBytes: 1, encryptedFileName: null, ttlSeconds: 600, maxDownloads: 1 });
    database.db.prepare("UPDATE transfers SET status = 'CONSUMED', expires_at = '2026-12-31T00:00:00.000Z' WHERE file_id = ?").run(created.fileId);
    expect(database.inspectAccess(created.fileId, hashToken('88'.repeat(32)), new Date('2026-10-07T00:00:00.000Z'))).toBe('INVALID');
    expect(database.inspectAccess(created.fileId, hashToken(authToken), new Date('2026-10-07T00:00:00.000Z'))).toBe('GONE');
    database.close();
  });

  it('claims expired transfers but protects an active download lease', () => {
    const database = new MetadataDatabase();
    const protectedTransfer = database.createTransfer({ authToken: '99'.repeat(32), totalSizeBytes: 1, chunkCount: 1, chunkSizeBytes: 1, encryptedFileName: null, ttlSeconds: 600, maxDownloads: 1 });
    const expiredTransfer = database.createTransfer({ authToken: 'aa'.repeat(32), totalSizeBytes: 1, chunkCount: 1, chunkSizeBytes: 1, encryptedFileName: null, ttlSeconds: 600, maxDownloads: 1 });
    database.db.prepare(`UPDATE transfers SET status = 'DOWNLOADING', expires_at = '2026-10-07T09:00:00.000Z', download_lease_until = '2026-10-07T10:30:00.000Z', created_at = '2026-10-07T08:00:00.000Z' WHERE file_id = ?`).run(protectedTransfer.fileId);
    database.db.prepare(`UPDATE transfers SET status = 'READY', expires_at = '2026-10-07T09:00:00.000Z', created_at = '2026-10-07T08:00:00.000Z' WHERE file_id = ?`).run(expiredTransfer.fileId);
    const claimed = database.claimDeletableTransfers(new Date('2026-10-07T10:00:00.000Z'));
    expect(claimed.map((transfer) => transfer.file_id)).toEqual([expiredTransfer.fileId]);
    expect(database.getTransfer(protectedTransfer.fileId)?.status).toBe('DOWNLOADING');
    expect(database.getTransfer(expiredTransfer.fileId)?.status).toBe('DELETING');
    database.close();
  });

  it('finalizes deletion only after every replica is confirmed deleted', () => {
    const database = new MetadataDatabase();
    database.registerStorageNode({ nodeId: 'node-a', endpointUrl: 'http://node-a', status: 'HEALTHY' });
    database.registerStorageNode({ nodeId: 'node-b', endpointUrl: 'http://node-b', status: 'HEALTHY' });
    const transfer = database.createTransfer({ authToken: 'bb'.repeat(32), totalSizeBytes: 1, chunkCount: 1, chunkSizeBytes: 1, encryptedFileName: null, ttlSeconds: 600, maxDownloads: 1 });
    const chunkId = `${transfer.fileId}-0`;
    database.db.prepare(`INSERT INTO chunks (chunk_id, file_id, chunk_index, size_bytes, checksum_sha256, status) VALUES (?, ?, 0, 1, ?, 'STORED')`).run(chunkId, transfer.fileId, 'a'.repeat(64));
    database.recordConfirmedReplicas(chunkId, ['node-a', 'node-b']);
    database.db.prepare("UPDATE transfers SET status = 'DELETING' WHERE file_id = ?").run(transfer.fileId);
    database.markReplicaDeleted(chunkId, 'node-a');
    expect(database.finalizeTransferDeletion(transfer.fileId)).toBe(false);
    database.markReplicaDeleted(chunkId, 'node-b');
    expect(database.finalizeTransferDeletion(transfer.fileId)).toBe(true);
    expect(database.getTransfer(transfer.fileId)?.status).toBe('DELETED');
    expect(database.getStoredChunks(transfer.fileId)).toEqual([]);
    database.close();
  });
});
