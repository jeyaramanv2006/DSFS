import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MetadataDatabase } from '../db/database.js';
import type { StoredChunkResult } from '../services/storage-client.js';
import { RecoveryService, type RecoveryTarget } from './recovery.js';

class MemoryNode {
  public constructor(private readonly content: Buffer | null) {}
  public async getChunk(): Promise<Readable> {
    if (!this.content) throw new Error('source unavailable');
    return Readable.from(this.content);
  }
  public async putChunk(_chunkId: string, input: NodeJS.ReadableStream, checksumSha256: string): Promise<StoredChunkResult> {
    const parts: Buffer[] = [];
    for await (const part of input as AsyncIterable<Buffer>) parts.push(part);
    const payload = Buffer.concat(parts);
    return { sizeBytes: payload.length, checksumSha256 };
  }
}

function setup(status = 'READY') {
  const database = new MetadataDatabase();
  database.registerStorageNode({ nodeId: 'source', endpointUrl: 'http://source', status: 'HEALTHY' });
  database.registerStorageNode({ nodeId: 'target', endpointUrl: 'http://target', status: 'HEALTHY' });
  const content = Buffer.from('recover me');
  const checksum = createHash('sha256').update(content).digest('hex');
  const transfer = database.createTransfer({
    authToken: 'aa'.repeat(32), totalSizeBytes: content.length, chunkCount: 1,
    chunkSizeBytes: content.length, encryptedFileName: null, ttlSeconds: 600, maxDownloads: 1,
  });
  database.db.prepare('UPDATE transfers SET status = ? WHERE file_id = ?').run(status, transfer.fileId);
  const chunkId = `${transfer.fileId}-0`;
  database.db.prepare(`INSERT INTO chunks (chunk_id, file_id, chunk_index, size_bytes, checksum_sha256, status) VALUES (?, ?, 0, ?, ?, 'STORED')`)
    .run(chunkId, transfer.fileId, content.length, checksum);
  database.recordConfirmedReplicas(chunkId, ['source']);
  return { database, chunkId, content };
}

describe('under-replicated chunk recovery', () => {
  it('copies from a healthy source to an eligible target and restores two replicas', async () => {
    const { database, chunkId, content } = setup();
    const targets: RecoveryTarget[] = [
      { nodeId: 'source', client: new MemoryNode(content) },
      { nodeId: 'target', client: new MemoryNode(null) },
    ];
    const report = await new RecoveryService(database, targets).recoverUnderReplicated();
    expect(report.skipped).toEqual([]);
    expect(report.recovered).toEqual([{ chunkId, sourceNodeId: 'source', targetNodeId: 'target' }]);
    expect(database.getConfirmedReplicas(chunkId).map((row) => row.node_id)).toEqual(['source', 'target']);
    database.close();
  });

  it('does not recover expired or deleting transfers', async () => {
    for (const status of ['EXPIRED', 'DELETING']) {
      const { database, chunkId, content } = setup(status);
      const report = await new RecoveryService(database, [
        { nodeId: 'source', client: new MemoryNode(content) },
        { nodeId: 'target', client: new MemoryNode(null) },
      ]).recoverUnderReplicated();
      expect(report.recovered).toEqual([]);
      expect(database.getConfirmedReplicas(chunkId).map((row) => row.node_id)).toEqual(['source']);
      database.close();
    }
  });

  it('skips a corrupt source without persisting a false target replica', async () => {
    const { database, chunkId } = setup();
    const report = await new RecoveryService(database, [
      { nodeId: 'source', client: new MemoryNode(Buffer.from('tampered')) },
      { nodeId: 'target', client: new MemoryNode(null) },
    ]).recoverUnderReplicated();
    expect(report.recovered).toEqual([]);
    expect(report.skipped).toEqual([chunkId]);
    expect(database.getConfirmedReplicas(chunkId).map((row) => row.node_id)).toEqual(['source']);
    database.close();
  });
});
