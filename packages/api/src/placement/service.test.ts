import { describe, expect, it } from 'vitest';
import { MetadataDatabase } from '../db/database.js';
import { PlacementService } from './service.js';

describe('placement service', () => {
  it('selects only healthy nodes and persists the ring result', () => {
    const database = new MetadataDatabase();
    database.registerStorageNode({ nodeId: 'node-a', endpointUrl: 'http://a', status: 'HEALTHY' });
    database.registerStorageNode({ nodeId: 'node-b', endpointUrl: 'http://b', status: 'HEALTHY' });
    database.registerStorageNode({ nodeId: 'node-c', endpointUrl: 'http://c', status: 'UNAVAILABLE' });
    const created = database.createTransfer({
      authToken: '55'.repeat(32), totalSizeBytes: 1, chunkCount: 1,
      chunkSizeBytes: 1, encryptedFileName: null, ttlSeconds: 600, maxDownloads: 1,
    });
    database.db.prepare(`INSERT INTO chunks (chunk_id, file_id, chunk_index, size_bytes, checksum_sha256, status) VALUES (?, ?, 0, 1, ?, 'STORED')`)
      .run(`${created.fileId}-0`, created.fileId, 'b'.repeat(64));
    const service = new PlacementService(database, 32);
    const selected = service.placeChunk(`${created.fileId}-0`, 2);
    expect(selected).toHaveLength(2);
    expect(selected).not.toContain('node-c');
    expect(database.getPlacement(`${created.fileId}-0`).map((row) => row.node_id)).toEqual(selected);
    database.close();
  });

  it('fails clearly when there are no healthy nodes', () => {
    const database = new MetadataDatabase();
    expect(() => new PlacementService(database).placeChunk('chunk-1')).toThrow('no healthy storage nodes');
    database.close();
  });

  it('filters healthy nodes that cannot fit the requested chunk capacity', () => {
    const database = new MetadataDatabase();
    database.registerStorageNode({ nodeId: 'small', endpointUrl: 'http://small', status: 'HEALTHY', totalCapacityBytes: 10, usedCapacityBytes: 9 });
    database.registerStorageNode({ nodeId: 'large', endpointUrl: 'http://large', status: 'HEALTHY', totalCapacityBytes: 100, usedCapacityBytes: 9 });
    const selected = new PlacementService(database, 32).selectNodes('chunk-capacity', 2, 5);
    expect(selected).toEqual(['large']);
    database.close();
  });
});
