import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MetadataDatabase } from '../db/database.js';
import type { StorageNodeClient } from '../services/storage-client.js';
import { NodeUnavailableError, ReplicaReadService, type ReplicaReadTarget } from './read-service.js';

class ReadNode implements Pick<StorageNodeClient, 'getChunk'> {
  public constructor(private readonly behavior: 'ok' | 'fail', private readonly body = 'data') {}
  public async getChunk(): Promise<Readable> {
    if (this.behavior === 'fail') throw new Error('connection refused');
    return Readable.from(Buffer.from(this.body));
  }
}

function setup() {
  const database = new MetadataDatabase();
  database.registerStorageNode({ nodeId: 'node-a', endpointUrl: 'http://a', status: 'UNHEALTHY' });
  database.registerStorageNode({ nodeId: 'node-b', endpointUrl: 'http://b', status: 'HEALTHY' });
  database.registerStorageNode({ nodeId: 'node-c', endpointUrl: 'http://c', status: 'HEALTHY' });
  const created = database.createTransfer({
    authToken: '99'.repeat(32), totalSizeBytes: 4, chunkCount: 1,
    chunkSizeBytes: 4, encryptedFileName: null, ttlSeconds: 600, maxDownloads: 1,
  });
  const chunkId = `${created.fileId}-0`;
  database.db.prepare(`INSERT INTO chunks (chunk_id, file_id, chunk_index, size_bytes, checksum_sha256, status) VALUES (?, ?, 0, 4, ?, 'STORED')`)
    .run(chunkId, created.fileId, 'a'.repeat(64));
  database.recordConfirmedReplicas(chunkId, ['node-a', 'node-b', 'node-c']);
  return { database, chunkId };
}

describe('replica read failover', () => {
  it('orders healthy replicas first and succeeds after a failed candidate', async () => {
    const { database, chunkId } = setup();
    const attempts: string[] = [];
    const targets: ReplicaReadTarget[] = [
      { nodeId: 'node-a', client: { getChunk: async () => { attempts.push('node-a'); throw new Error('down'); } } },
      { nodeId: 'node-b', client: { getChunk: async () => { attempts.push('node-b'); return Readable.from(Buffer.from('from-b')); } } },
      { nodeId: 'node-c', client: { getChunk: async () => { attempts.push('node-c'); return Readable.from(Buffer.from('from-c')); } } },
    ];
    const stream = await new ReplicaReadService(database, targets).getChunk(chunkId);
    expect(attempts).toEqual(['node-b']);
    expect(await streamToString(stream)).toBe('from-b');
    database.close();
  });

  it('tries every replica and returns a typed NODE_UNAVAILABLE error after exhaustion', async () => {
    const { database, chunkId } = setup();
    const targets: ReplicaReadTarget[] = [
      { nodeId: 'node-a', client: new ReadNode('fail') },
      { nodeId: 'node-b', client: new ReadNode('fail') },
      { nodeId: 'node-c', client: new ReadNode('fail') },
    ];
    await expect(new ReplicaReadService(database, targets).getChunk(chunkId))
      .rejects.toBeInstanceOf(NodeUnavailableError);
    database.close();
  });
});

async function streamToString(stream: Readable): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
  return Buffer.concat(parts).toString('utf8');
}
