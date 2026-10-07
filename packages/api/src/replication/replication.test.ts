import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MetadataDatabase } from '../db/database.js';
import { PlacementService } from '../placement/service.js';
import type { StoredChunkResult } from '../services/storage-client.js';
import { ReplicationService, type ReplicaTarget } from './replication.js';

class FakeReplica {
  public readonly writes: string[] = [];
  public constructor(private readonly shouldFail = false, private readonly delayMs = 0) {}

  public async putChunk(chunkId: string, input: NodeJS.ReadableStream, checksumSha256: string): Promise<StoredChunkResult> {
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    for await (const _chunk of input as AsyncIterable<Buffer>) { /* consume the stream */ }
    if (this.shouldFail) throw new Error('node unavailable');
    this.writes.push(chunkId);
    return { sizeBytes: 4, checksumSha256 };
  }
}

function setup() {
  const database = new MetadataDatabase();
  for (const nodeId of ['node-a', 'node-b', 'node-c']) {
    database.registerStorageNode({ nodeId, endpointUrl: `http://${nodeId}`, status: 'HEALTHY' });
  }
  const created = database.createTransfer({
    authToken: '66'.repeat(32), totalSizeBytes: 4, chunkCount: 1,
    chunkSizeBytes: 4, encryptedFileName: null, ttlSeconds: 600, maxDownloads: 1,
  });
  const chunkId = `${created.fileId}-0`;
  database.db.prepare(`INSERT INTO chunks (chunk_id, file_id, chunk_index, size_bytes, checksum_sha256, status) VALUES (?, ?, 0, 4, ?, 'STORED')`)
    .run(chunkId, created.fileId, createHash('sha256').update('data').digest('hex'));
  return { database, chunkId };
}

describe('replication service', () => {
  it('writes two distinct placements concurrently and persists only confirmations', async () => {
    const { database, chunkId } = setup();
    const payload = Buffer.from('data');
    const checksum = createHash('sha256').update(payload).digest('hex');
    const fakes = [new FakeReplica(), new FakeReplica(), new FakeReplica()];
    const targets: ReplicaTarget[] = ['node-a', 'node-b', 'node-c'].map((nodeId, index) => ({ nodeId, client: fakes[index] }));
    const result = await new ReplicationService(database, new PlacementService(database, 32), targets)
      .replicateChunk(chunkId, payload, checksum);
    expect(result.confirmedNodeIds).toHaveLength(2);
    expect(new Set(result.confirmedNodeIds).size).toBe(2);
    expect(database.getConfirmedReplicas(chunkId).map((row) => row.node_id)).toEqual(result.confirmedNodeIds);
    expect(fakes.reduce((count, fake) => count + fake.writes.length, 0)).toBe(2);
    database.close();
  });

  it('retries the next ring node after a replica failure', async () => {
    const { database, chunkId } = setup();
    const payload = Buffer.from('data');
    const checksum = createHash('sha256').update(payload).digest('hex');
    const placement = new PlacementService(database, 32);
    const ordered = placement.selectNodes(chunkId, 3);
    const fakes = new Map(ordered.map((nodeId, index) => [nodeId, new FakeReplica(index === 0)]));
    const targets: ReplicaTarget[] = ordered.map((nodeId) => ({ nodeId, client: fakes.get(nodeId)! }));
    const result = await new ReplicationService(database, placement, targets)
      .replicateChunk(chunkId, payload, checksum);
    expect(result.confirmedNodeIds).toHaveLength(2);
    expect(result.failedNodeIds).toHaveLength(1);
    expect(database.getConfirmedReplicas(chunkId).map((row) => row.node_id)).toEqual(result.confirmedNodeIds);
    database.close();
  });

  it('does not claim replication success when fewer than two nodes confirm', async () => {
    const { database, chunkId } = setup();
    const payload = Buffer.from('data');
    const checksum = createHash('sha256').update(payload).digest('hex');
    const targets: ReplicaTarget[] = ['node-a', 'node-b', 'node-c'].map((nodeId) => ({ nodeId, client: new FakeReplica(true) }));
    await expect(new ReplicationService(database, new PlacementService(database, 32), targets)
      .replicateChunk(chunkId, payload, checksum)).rejects.toThrow('replication failed');
    expect(database.getConfirmedReplicas(chunkId)).toEqual([]);
    database.close();
  });
});
