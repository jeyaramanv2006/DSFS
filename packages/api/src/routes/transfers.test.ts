import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { MetadataDatabase } from '../db/database.js';
import { buildApiServer } from '../server.js';
import type { StorageNodeClient, StoredChunkResult } from '../services/storage-client.js';
import { NodeUnavailableError } from '../replication/read-service.js';

const authToken = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

class FakeStorageNodeClient implements StorageNodeClient {
  public readonly writes: Array<{ chunkId: string; body: Buffer; checksumSha256: string }> = [];
  public readonly chunks = new Map<string, Buffer>();

  public async putChunk(
    chunkId: string,
    input: NodeJS.ReadableStream,
    checksumSha256: string,
  ): Promise<StoredChunkResult> {
    const chunks: Buffer[] = [];
    for await (const chunk of input as AsyncIterable<Buffer | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    this.writes.push({ chunkId, body, checksumSha256 });
    this.chunks.set(chunkId, body);
    return {
      sizeBytes: body.byteLength,
      checksumSha256: createHash('sha256').update(body).digest('hex'),
    };
  }

  public async getChunk(chunkId: string): Promise<Readable> {
    const body = this.chunks.get(chunkId);
    if (!body) throw new Error('chunk not found');
    return Readable.from(body);
  }
}

describe('POST /api/transfers', () => {
  let database: MetadataDatabase | undefined;
  let app: Awaited<ReturnType<typeof buildApiServer>> | undefined;

  afterEach(async () => {
    await app?.close();
    database?.close();
  });

  it('creates a transfer and returns a separate upload session token', async () => {
    database = new MetadataDatabase();
    app = buildApiServer(database);

    const response = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      payload: {
        authToken,
        totalSizeBytes: 8 * 1024 * 1024,
        chunkCount: 2,
        chunkSizeBytes: 4 * 1024 * 1024,
        ttlSeconds: 3600,
        maxDownloads: 1,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ status: 'CREATING' });
    expect(body.fileId).toMatch(/^[a-f0-9]{32}$/);
    expect(body.uploadToken).toMatch(/^[a-f0-9]{64}$/);
    expect(body.chunkUploads).toHaveLength(2);
    expect(body.uploadToken).not.toBe(authToken);

    const row = database.db.prepare('SELECT * FROM transfers WHERE file_id = ?').get(body.fileId) as Record<string, unknown>;
    expect(row.capability_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.upload_session_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.capability_hash).not.toBe(authToken);
    expect(row.upload_session_hash).not.toBe(body.uploadToken);
  });

  it('rejects invalid size, TTL, and chunk-count combinations', async () => {
    database = new MetadataDatabase();
    app = buildApiServer(database);

    const response = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      payload: {
        authToken,
        totalSizeBytes: 200 * 1024 * 1024 + 1,
        chunkCount: 1,
        chunkSizeBytes: 4 * 1024 * 1024,
        ttlSeconds: 601,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(database.db.prepare('SELECT count(*) AS count FROM transfers').pluck().get()).toBe(0);
  });

  it('authorizes upload, forwards the stream, and records the stored chunk', async () => {
    database = new MetadataDatabase();
    const storage = new FakeStorageNodeClient();
    app = buildApiServer(database, storage);
    const init = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      payload: { authToken, totalSizeBytes: 5, chunkCount: 1, chunkSizeBytes: 4 * 1024 * 1024, ttlSeconds: 600 },
    });
    const initialized = init.json();
    const content = Buffer.from('hello');
    const checksum = createHash('sha256').update(content).digest('hex');

    const upload = await app.inject({
      method: 'PUT',
      url: `/api/transfers/${initialized.fileId}/chunks/0`,
      headers: {
        authorization: `Bearer ${initialized.uploadToken}`,
        'content-type': 'application/octet-stream',
        'x-chunk-checksum-sha256': checksum,
      },
      payload: content,
    });

    expect(upload.statusCode).toBe(200);
    expect(storage.writes).toEqual([{ chunkId: `${initialized.fileId}-0`, body: content, checksumSha256: checksum }]);
    expect(database.db.prepare('SELECT status FROM transfers WHERE file_id = ?').pluck().get(initialized.fileId)).toBe('UPLOADING');
    expect(database.db.prepare('SELECT chunk_index, size_bytes, checksum_sha256, status FROM chunks WHERE file_id = ?').get(initialized.fileId)).toEqual({
      chunk_index: 0,
      size_bytes: 5,
      checksum_sha256: checksum,
      status: 'STORED',
    });
  });

  it('does not forward a chunk with an invalid upload-session token', async () => {
    database = new MetadataDatabase();
    const storage = new FakeStorageNodeClient();
    app = buildApiServer(database, storage);
    const init = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      payload: { authToken, totalSizeBytes: 5, chunkCount: 1, ttlSeconds: 600 },
    });
    const initialized = init.json();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/transfers/${initialized.fileId}/chunks/0`,
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': 'application/octet-stream',
      },
      payload: 'hello',
    });

    expect(response.statusCode).toBe(404);
    expect(storage.writes).toHaveLength(0);
  });

  it('finalizes only after every expected chunk is stored', async () => {
    database = new MetadataDatabase();
    const storage = new FakeStorageNodeClient();
    app = buildApiServer(database, storage);
    const init = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      payload: { authToken, totalSizeBytes: 5, chunkCount: 1, ttlSeconds: 600 },
    });
    const initialized = init.json();
    const finalizeHeaders = { authorization: `Bearer ${initialized.uploadToken}` };

    const incomplete = await app.inject({
      method: 'POST',
      url: `/api/transfers/${initialized.fileId}/finalize`,
      headers: finalizeHeaders,
      payload: { totalChunksUploaded: 0 },
    });
    expect(incomplete.statusCode).toBe(409);

    const content = Buffer.from('hello');
    const checksum = createHash('sha256').update(content).digest('hex');
    await app.inject({
      method: 'PUT',
      url: `/api/transfers/${initialized.fileId}/chunks/0`,
      headers: {
        ...finalizeHeaders,
        'content-type': 'application/octet-stream',
        'x-chunk-checksum-sha256': checksum,
      },
      payload: content,
    });
    const finalized = await app.inject({
      method: 'POST',
      url: `/api/transfers/${initialized.fileId}/finalize`,
      headers: finalizeHeaders,
      payload: { totalChunksUploaded: 1 },
    });

    expect(finalized.statusCode).toBe(200);
    expect(finalized.json()).toMatchObject({ fileId: initialized.fileId, status: 'READY' });
  });

  it('reports uploaded and missing chunk indices for resumable uploads', async () => {
    database = new MetadataDatabase();
    const storage = new FakeStorageNodeClient();
    app = buildApiServer(database, storage);
    const init = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      payload: {
        authToken,
        totalSizeBytes: 8 * 1024 * 1024,
        chunkCount: 2,
        chunkSizeBytes: 4 * 1024 * 1024,
        ttlSeconds: 600,
      },
    });
    const initialized = init.json();
    const content = Buffer.from('second chunk');
    const checksum = createHash('sha256').update(content).digest('hex');
    const headers = {
      authorization: `Bearer ${initialized.uploadToken}`,
      'content-type': 'application/octet-stream',
      'x-chunk-checksum-sha256': checksum,
    };
    await app.inject({
      method: 'PUT',
      url: `/api/transfers/${initialized.fileId}/chunks/1`,
      headers,
      payload: content,
    });

    const status = await app.inject({
      method: 'GET',
      url: `/api/transfers/${initialized.fileId}/status`,
      headers: { authorization: `Bearer ${initialized.uploadToken}` },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      fileId: initialized.fileId,
      status: 'UPLOADING',
      chunkCount: 2,
      uploadedChunkIndices: [1],
      missingChunkIndices: [0],
    });
  });

  it('authorizes access, returns an opaque lease token and manifest, streams chunks, and completes', async () => {
    database = new MetadataDatabase();
    const storage = new FakeStorageNodeClient();
    app = buildApiServer(database, storage);
    const init = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      payload: { authToken, totalSizeBytes: 5, chunkCount: 1, ttlSeconds: 600, maxDownloads: 1 },
    });
    const initialized = init.json();
    const content = Buffer.from('hello');
    const checksum = createHash('sha256').update(content).digest('hex');
    await app.inject({
      method: 'PUT',
      url: `/api/transfers/${initialized.fileId}/chunks/0`,
      headers: {
        authorization: `Bearer ${initialized.uploadToken}`,
        'content-type': 'application/octet-stream',
        'x-chunk-checksum-sha256': checksum,
      },
      payload: content,
    });
    await app.inject({
      method: 'POST',
      url: `/api/transfers/${initialized.fileId}/finalize`,
      headers: { authorization: `Bearer ${initialized.uploadToken}` },
      payload: { totalChunksUploaded: 1 },
    });

    const access = await app.inject({
      method: 'POST',
      url: `/api/transfers/${initialized.fileId}/access`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(access.statusCode).toBe(200);
    const accessBody = access.json();
    expect(accessBody.downloadToken).toMatch(/^[a-f0-9]{64}$/);
    expect(accessBody.downloadToken).not.toBe(authToken);
    expect(accessBody.manifest).toEqual([{ chunkIndex: 0, sizeBytes: 5, checksumSha256: checksum }]);

    const chunk = await app.inject({
      method: 'GET',
      url: `/api/transfers/${initialized.fileId}/chunks/0`,
      headers: { authorization: `Bearer ${accessBody.downloadToken}` },
    });
    expect(chunk.statusCode).toBe(200);
    expect(chunk.rawPayload).toEqual(content);

    const complete = await app.inject({
      method: 'POST',
      url: `/api/transfers/${initialized.fileId}/complete`,
      headers: { authorization: `Bearer ${accessBody.downloadToken}` },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({ status: 'CONSUMED', downloadCount: 1 });

    const replay = await app.inject({
      method: 'GET',
      url: `/api/transfers/${initialized.fileId}/chunks/0`,
      headers: { authorization: `Bearer ${accessBody.downloadToken}` },
    });
    expect(replay.statusCode).toBe(404);
  });

  it('returns byte-identical errors for an invalid capability and an unknown transfer', async () => {
    database = new MetadataDatabase();
    app = buildApiServer(database, new FakeStorageNodeClient());
    const init = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      payload: { authToken, totalSizeBytes: 5, chunkCount: 1, ttlSeconds: 600 },
    });
    const initialized = init.json();
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/transfers/${initialized.fileId}/access`,
      headers: { authorization: `Bearer ${'11'.repeat(32)}` },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: `/api/transfers/${'22'.repeat(16)}/access`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(invalid.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(invalid.body).toBe(unknown.body);
  });

  it('returns 404 for invalid capability but 410 for a valid consumed transfer', async () => {
    database = new MetadataDatabase();
    app = buildApiServer(database, new FakeStorageNodeClient());
    const init = await app.inject({ method: 'POST', url: '/api/transfers', payload: { authToken, totalSizeBytes: 5, chunkCount: 1, ttlSeconds: 600 } });
    const initialized = init.json();
    database.db.prepare("UPDATE transfers SET status = 'CONSUMED' WHERE file_id = ?").run(initialized.fileId);
    const invalid = await app.inject({ method: 'POST', url: `/api/transfers/${initialized.fileId}/access`, headers: { authorization: `Bearer ${'11'.repeat(32)}` } });
    const gone = await app.inject({ method: 'POST', url: `/api/transfers/${initialized.fileId}/access`, headers: { authorization: `Bearer ${authToken}` } });
    expect(invalid.statusCode).toBe(404);
    expect(gone.statusCode).toBe(410);
    expect(gone.json()).toEqual({ error: 'TRANSFER_GONE' });
  });

  it('returns typed NODE_UNAVAILABLE after authenticated replica exhaustion', async () => {
    database = new MetadataDatabase();
    const storage = new FakeStorageNodeClient();
    const readService = { getChunk: async () => { throw new NodeUnavailableError(); } };
    app = buildApiServer(database, storage, undefined, readService);
    const init = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      payload: { authToken, totalSizeBytes: 5, chunkCount: 1, ttlSeconds: 600 },
    });
    const initialized = init.json();
    const content = Buffer.from('hello');
    const checksum = createHash('sha256').update(content).digest('hex');
    const uploadHeaders = {
      authorization: `Bearer ${initialized.uploadToken}`,
      'content-type': 'application/octet-stream',
      'x-chunk-checksum-sha256': checksum,
    };
    await app.inject({ method: 'PUT', url: `/api/transfers/${initialized.fileId}/chunks/0`, headers: uploadHeaders, payload: content });
    await app.inject({ method: 'POST', url: `/api/transfers/${initialized.fileId}/finalize`, headers: { authorization: `Bearer ${initialized.uploadToken}` }, payload: { totalChunksUploaded: 1 } });
    const access = await app.inject({ method: 'POST', url: `/api/transfers/${initialized.fileId}/access`, headers: { authorization: `Bearer ${authToken}` } });
    const downloadToken = access.json().downloadToken;
    const response = await app.inject({
      method: 'GET',
      url: `/api/transfers/${initialized.fileId}/chunks/0`,
      headers: { authorization: `Bearer ${downloadToken}` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'NODE_UNAVAILABLE' });
  });
});
