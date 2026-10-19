import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesystemChunkStore } from './storage.js';

const checksum = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createStore(): Promise<FilesystemChunkStore> {
  const directory = await mkdtemp(join(tmpdir(), 'voidshare-node-'));
  temporaryDirectories.push(directory);
  return new FilesystemChunkStore(directory, 'node-test', 1024);
}

describe('FilesystemChunkStore', () => {
  it('puts, gets, checks, and deletes a chunk', async () => {
    const store = await createStore();
    const content = 'encrypted chunk bytes';
    const result = await store.putChunk('chunk-1', Readable.from([content]), checksum(content));

    expect(result).toEqual({ sizeBytes: content.length, checksumSha256: checksum(content) });
    expect(await store.hasChunk('chunk-1')).toBe(true);
    await expect(store.getChunk('chunk-1').then((stream) => stream.toArray())).resolves.toEqual([
      Buffer.from(content),
    ]);
    expect(await store.deleteChunk('chunk-1')).toBe(true);
    expect(await store.deleteChunk('chunk-1')).toBe(false);
    expect(await store.hasChunk('chunk-1')).toBe(false);
  });

  it('reports stored bytes and ignores temporary files', async () => {
    const store = await createStore();
    const content = '12345';
    await store.putChunk('chunk-1', Readable.from([content]), checksum(content));

    const health = await store.healthCheck();
    expect(health).toMatchObject({
      nodeId: 'node-test',
      status: 'HEALTHY',
      totalCapacityBytes: 1024,
      usedCapacityBytes: content.length,
      activeOperations: 0,
    });
    expect(await store.listChunks()).toEqual(['chunk-1']);
  });

  it('rejects path traversal and unsafe checksum input', async () => {
    const store = await createStore();

    await expect(store.hasChunk('../escape')).rejects.toThrow('invalid chunk ID');
    await expect(
      store.putChunk('chunk-1', Readable.from(['data']), 'not-a-checksum'),
    ).rejects.toThrow('invalid SHA-256 checksum');
  });

  it('removes the temporary file when checksum verification fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'voidshare-node-'));
    temporaryDirectories.push(directory);
    const store = new FilesystemChunkStore(directory, 'node-test');

    await expect(
      store.putChunk('chunk-1', Readable.from(['wrong bytes']), 'a'.repeat(64)),
    ).rejects.toThrow('checksum mismatch');

    expect(await readdir(directory)).toEqual([]);
    expect(await store.hasChunk('chunk-1')).toBe(false);
  });

  it('tracks capacity incrementally on put, overwrite, and delete', async () => {
    const store = await createStore();
    const c1 = 'hello';
    const c2 = 'world!!!';

    await store.putChunk('chunk-1', Readable.from([c1]), checksum(c1));
    expect((await store.healthCheck()).usedCapacityBytes).toBe(5);

    await store.putChunk('chunk-2', Readable.from([c2]), checksum(c2));
    expect((await store.healthCheck()).usedCapacityBytes).toBe(13);

    // Overwrite chunk-1 with longer content (10 bytes)
    const c1New = '0123456789';
    await store.putChunk('chunk-1', Readable.from([c1New]), checksum(c1New));
    expect((await store.healthCheck()).usedCapacityBytes).toBe(18); // 10 + 8

    // Delete chunk-2
    await store.deleteChunk('chunk-2');
    expect((await store.healthCheck()).usedCapacityBytes).toBe(10); // only chunk-1 remains
  });

  it('reconciles pre-existing chunks on startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'voidshare-node-'));
    temporaryDirectories.push(directory);

    // First store instance writes a chunk
    const store1 = new FilesystemChunkStore(directory, 'node-test', 2048);
    const content = 'pre-existing bytes';
    await store1.putChunk('chunk-pre', Readable.from([content]), checksum(content));

    // Second store instance starts on same directory
    const store2 = new FilesystemChunkStore(directory, 'node-test', 2048);
    // Before any operation, reconcile or healthCheck discovers on-disk chunks
    const health = await store2.healthCheck();
    expect(health.usedCapacityBytes).toBe(content.length);
    expect(await store2.listChunks()).toEqual(['chunk-pre']);
  });
});

