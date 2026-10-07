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
    expect(database.db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'").pluck().get()).toBe(5);
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
});
