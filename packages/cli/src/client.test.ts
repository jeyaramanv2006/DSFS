import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { MetadataDatabase } from '../../api/src/db/database.js';
import { buildApiServer } from '../../api/src/server.js';
import type { StorageNodeClient, StoredChunkResult } from '../../api/src/services/storage-client.js';
import { downloadBytes, downloadByCode, resolveTransfer, uploadBytes } from './client.js';

class MemoryStorage implements StorageNodeClient {
  private readonly chunks = new Map<string, Buffer>();
  public corruptReads = false;

  public async putChunk(chunkId: string, input: NodeJS.ReadableStream, checksumSha256: string): Promise<StoredChunkResult> {
    const parts: Buffer[] = [];
    for await (const part of input as AsyncIterable<Buffer | string>) {
      parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
    }
    const body = Buffer.concat(parts);
    const checksum = createHash('sha256').update(body).digest('hex');
    if (checksum !== checksumSha256) throw new Error('checksum mismatch');
    this.chunks.set(chunkId, body);
    return { sizeBytes: body.length, checksumSha256: checksum };
  }

  public async getChunk(chunkId: string): Promise<Readable> {
    const body = this.chunks.get(chunkId);
    if (!body) throw new Error('chunk not found');
    const result = Buffer.from(body);
    if (this.corruptReads) result[0] ^= 0xff;
    return Readable.from(result);
  }
}

describe('CLI encrypted round trip', () => {
  let app: Awaited<ReturnType<typeof buildApiServer>> | undefined;
  let database: MetadataDatabase | undefined;

  afterEach(async () => {
    await app?.close();
    database?.close();
  });

  it('encrypts before upload and decrypts after verified download', async () => {
    database = new MetadataDatabase();
    app = buildApiServer(database, new MemoryStorage());
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const plaintext = new TextEncoder().encode('private CLI payload');
    const uploaded = await uploadBytes(baseUrl, plaintext, {
      secret: '11'.repeat(32),
      fileName: 'private.txt',
      chunkSizeBytes: 8,
    });
    const downloaded = await downloadBytes(baseUrl, uploaded.fileId, uploaded.secret);
    expect(downloaded).toEqual(plaintext);
  });

  it('fails safely when a stored ciphertext chunk is corrupted', async () => {
    database = new MetadataDatabase();
    const storage = new MemoryStorage();
    app = buildApiServer(database, storage);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const uploaded = await uploadBytes(`http://127.0.0.1:${address.port}`, new TextEncoder().encode('integrity'), {
      secret: '22'.repeat(32),
      chunkSizeBytes: 16,
    });
    storage.corruptReads = true;
    await expect(downloadBytes(`http://127.0.0.1:${address.port}`, uploaded.fileId, uploaded.secret))
      .rejects.toThrow('downloaded chunk checksum mismatch');
    expect(database.db.prepare('SELECT status, download_count FROM transfers WHERE file_id = ?').get(uploaded.fileId))
      .toEqual({ status: 'DOWNLOADING', download_count: 0 });
  });

  it('allows retrieval by both link credentials and retrieval code, downloading identical bytes', async () => {
    database = new MetadataDatabase();
    const storage = new MemoryStorage();
    app = buildApiServer(database, storage);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const originalPayload = new TextEncoder().encode('confidential multi-channel data payload 12345');
    const uploaded = await uploadBytes(baseUrl, originalPayload, {
      fileName: 'secret-document.pdf',
      chunkSizeBytes: 16,
    });

    expect(uploaded.retrievalCode).toHaveLength(43);
    expect(uploaded.retrievalCode).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // 1. Resolve preview before download (does not consume download lease or count)
    const preview = await resolveTransfer(baseUrl, uploaded.retrievalCode);
    expect(preview.fileId).toBe(uploaded.fileId);
    expect(preview.status).toBe('READY');

    const transferBefore = database.db.prepare('SELECT download_count, status FROM transfers WHERE file_id = ?').get(uploaded.fileId);
    expect(transferBefore).toEqual({ download_count: 0, status: 'READY' });

    // 2. Download via retrieval code
    const downloadedByCode = await downloadByCode(baseUrl, uploaded.retrievalCode);
    expect(downloadedByCode).toEqual(originalPayload);

    // 3. Since max_downloads is 1, transfer is now CONSUMED
    const transferAfter = database.db.prepare('SELECT download_count, status FROM transfers WHERE file_id = ?').get(uploaded.fileId);
    expect(transferAfter).toEqual({ download_count: 1, status: 'CONSUMED' });

    // 4. Subsequent download attempts via link or code fail with 410 GONE
    await expect(downloadBytes(baseUrl, uploaded.fileId, uploaded.secret))
      .rejects.toThrow('VoidShare API request failed with 410');
    await expect(downloadByCode(baseUrl, uploaded.retrievalCode))
      .rejects.toThrow('VoidShare API request failed with 410');
  });

  it('rejects malformed retrieval codes before network requests', async () => {
    await expect(downloadByCode('http://127.0.0.1:9999', 'too-short'))
      .rejects.toThrow('invalid retrieval code');
    await expect(downloadByCode('http://127.0.0.1:9999', 'invalid-chars-with-+and/=padding-bytes-43!'))
      .rejects.toThrow('invalid retrieval code');
  });
});
