import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { MetadataDatabase } from '../db/database.js';
import { buildApiServer } from '../server.js';
import type { StorageNodeClient, StoredChunkResult } from '../services/storage-client.js';
import { NodeUnavailableError } from '../replication/read-service.js';
import { ReplicationError } from '../replication/replication.js';

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

  it('enforces maximum 48-hour (172800s) expiration limit', async () => {
    database = new MetadataDatabase();
    app = buildApiServer(database);

    // 48 hours (172800s) is accepted
    const valid48h = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      payload: {
        authToken,
        totalSizeBytes: 1024,
        chunkCount: 1,
        chunkSizeBytes: 4 * 1024 * 1024,
        ttlSeconds: 172800,
        maxDownloads: 5,
      },
    });
    expect(valid48h.statusCode).toBe(201);

    // Anything beyond 48 hours (e.g., 72 hours / 259200s) is strictly rejected
    const invalidOver48h = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      payload: {
        authToken,
        totalSizeBytes: 1024,
        chunkCount: 1,
        chunkSizeBytes: 4 * 1024 * 1024,
        ttlSeconds: 259200,
      },
    });
    expect(invalidOver48h.statusCode).toBe(400);
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

  it('returns 503 REPLICATION_DEGRADED when required replicas are not achieved', async () => {
    database = new MetadataDatabase();
    const fakeReplicator = {
      replicateChunk: async () => {
        throw new ReplicationError(['node-1'], ['node-2'], 2);
      },
    };
    app = buildApiServer(database, undefined, fakeReplicator);
    const init = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      payload: { authToken, totalSizeBytes: 5, chunkCount: 1, ttlSeconds: 600 },
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
    expect(upload.statusCode).toBe(503);
    expect(upload.json()).toEqual({
      error: 'REPLICATION_DEGRADED',
      confirmedReplicas: 1,
      requiredReplicas: 2,
    });

    // Chunk must not be marked STORED
    expect(database.countStoredChunks(initialized.fileId)).toBe(0);

    // Finalize must fail
    const finalize = await app.inject({
      method: 'POST',
      url: `/api/transfers/${initialized.fileId}/finalize`,
      headers: { authorization: `Bearer ${initialized.uploadToken}` },
      payload: { totalChunksUploaded: 1 },
    });
    expect(finalize.statusCode).toBe(400);

    // Event must be logged
    const events = database.listClusterEvents({ eventType: 'REPLICATION_DEGRADED' });
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe('WARN');
  });

  it('rejects duplicate authToken on init with 409 DUPLICATE_CAPABILITY', async () => {
    database = new MetadataDatabase();
    app = buildApiServer(database);

    const first = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      payload: { authToken, totalSizeBytes: 10, chunkCount: 1, ttlSeconds: 600 },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      payload: { authToken, totalSizeBytes: 10, chunkCount: 1, ttlSeconds: 600 },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'DUPLICATE_CAPABILITY' });
  });

  it('resolves transfers safely via POST /api/transfers/resolve without consuming quota', async () => {
    database = new MetadataDatabase();
    const fakeClient = new FakeStorageNodeClient();
    app = buildApiServer(database, fakeClient);

    // Initialize, upload, and finalize transfer
    const init = await app.inject({
      method: 'POST',
      url: '/api/transfers',
      payload: {
        authToken,
        totalSizeBytes: 5,
        chunkCount: 1,
        ttlSeconds: 600,
        maxDownloads: 1,
        encryptedFileName: 'encrypted-filename-blob',
      },
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

    // 1. Resolve via Authorization Bearer header
    const resolveRes = await app.inject({
      method: 'POST',
      url: '/api/transfers/resolve',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(resolveRes.statusCode).toBe(200);
    const resolved = resolveRes.json();
    expect(resolved).toEqual({
      fileId: initialized.fileId,
      status: 'READY',
      totalSizeBytes: 5,
      chunkCount: 1,
      chunkSizeBytes: 4 * 1024 * 1024,
      encryptedFileName: 'encrypted-filename-blob',
      expiresAt: initialized.expiresAt,
      downloadCount: 0,
      maxDownloads: 1,
    });
    // Ensure no secrets leaked
    expect(resolved.authToken).toBeUndefined();
    expect(resolved.capability_hash).toBeUndefined();
    expect(resolved.upload_session_hash).toBeUndefined();
    expect(resolved.downloadToken).toBeUndefined();

    // Verify lease was not acquired and download quota was not touched
    const transferRow = database.getTransfer(initialized.fileId)!;
    expect(transferRow.status).toBe('READY');
    expect(transferRow.download_count).toBe(0);
    expect(transferRow.download_lease_until).toBeNull();

    // 2. Resolve via body authToken
    const resolveBodyRes = await app.inject({
      method: 'POST',
      url: '/api/transfers/resolve',
      payload: { authToken },
    });
    expect(resolveBodyRes.statusCode).toBe(200);
    expect(resolveBodyRes.json().fileId).toBe(initialized.fileId);

    // 3. Unknown token fails safely with 404
    const unknownToken = '1111111111111111111111111111111111111111111111111111111111111111';
    const unknownRes = await app.inject({
      method: 'POST',
      url: '/api/transfers/resolve',
      headers: { authorization: `Bearer ${unknownToken}` },
    });
    expect(unknownRes.statusCode).toBe(404);
    expect(unknownRes.json()).toEqual({ error: 'TRANSFER_NOT_FOUND' });

    // 4. Preview via GET /api/transfers/:fileId/preview
    const previewRes = await app.inject({
      method: 'GET',
      url: `/api/transfers/${initialized.fileId}/preview`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(previewRes.statusCode).toBe(200);
    expect(previewRes.json()).toEqual(resolved);

    // Preview with wrong token returns 404
    const wrongPreviewRes = await app.inject({
      method: 'GET',
      url: `/api/transfers/${initialized.fileId}/preview`,
      headers: { authorization: `Bearer ${unknownToken}` },
    });
    expect(wrongPreviewRes.statusCode).toBe(404);

    // 5. Expired transfer returns 410 GONE on resolve and preview
    database.db.prepare("UPDATE transfers SET expires_at = '2000-01-01T00:00:00.000Z' WHERE file_id = ?").run(initialized.fileId);

    const expiredResolve = await app.inject({
      method: 'POST',
      url: '/api/transfers/resolve',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(expiredResolve.statusCode).toBe(410);
    expect(expiredResolve.json()).toEqual({ error: 'TRANSFER_GONE' });

    const expiredPreview = await app.inject({
      method: 'GET',
      url: `/api/transfers/${initialized.fileId}/preview`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(expiredPreview.statusCode).toBe(410);
    expect(expiredPreview.json()).toEqual({ error: 'TRANSFER_GONE' });
  });

  it('fails closed when capability lookup is ambiguous', async () => {
    database = new MetadataDatabase();
    app = buildApiServer(database);

    // Force two rows with same capability_hash directly in DB
    const capHash = createHash('sha256').update(Buffer.from(authToken, 'hex')).digest('hex');
    database.db.prepare(`
      INSERT INTO transfers (file_id, capability_hash, upload_session_hash, total_size_bytes, chunk_count, chunk_size_bytes, status, max_downloads, expires_at)
      VALUES ('file-1', ?, 'sess-1', 10, 1, 10, 'READY', 1, '2099-01-01T00:00:00.000Z')
    `).run(capHash);
    database.db.prepare(`
      INSERT INTO transfers (file_id, capability_hash, upload_session_hash, total_size_bytes, chunk_count, chunk_size_bytes, status, max_downloads, expires_at)
      VALUES ('file-2', ?, 'sess-2', 10, 1, 10, 'READY', 1, '2099-01-01T00:00:00.000Z')
    `).run(capHash);

    const res = await app.inject({
      method: 'POST',
      url: '/api/transfers/resolve',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'TRANSFER_NOT_FOUND' });

    const events = database.listClusterEvents({ eventType: 'CAPABILITY_LOOKUP_AMBIGUOUS' });
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe('ERROR');
  });
});

