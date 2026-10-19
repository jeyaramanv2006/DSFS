import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesystemChunkStore } from './storage.js';
import { buildServer } from './server.js';

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

describe('storage node HTTP server', () => {
  let dataDir: string;
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'voidshare-http-'));
    app = buildServer(new FilesystemChunkStore(dataDir, 'node-http', 1000));
  });

  afterEach(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('puts and gets binary chunk data and reports health', async () => {
    const content = 'hello';
    const put = await app.inject({
      method: 'PUT',
      url: '/chunks/abc123',
      headers: {
        'content-type': 'application/octet-stream',
        'x-checksum': sha256(content),
      },
      payload: content,
    });

    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      chunkId: 'abc123',
      storedSizeBytes: content.length,
      checksumVerified: true,
    });

    const get = await app.inject({ method: 'GET', url: '/chunks/abc123' });
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toContain('application/octet-stream');
    expect(get.body).toBe(content);

    const listing = await app.inject({ method: 'GET', url: '/chunks' });
    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toEqual({ chunks: ['abc123'] });

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      nodeId: 'node-http',
      status: 'HEALTHY',
      usedCapacityBytes: content.length,
      totalCapacityBytes: 1000,
    });
  });

  it('supports HEAD and idempotent DELETE', async () => {
    const content = 'delete me';
    const headers = {
      'content-type': 'application/octet-stream',
      'x-checksum': sha256(content),
    };
    await app.inject({ method: 'PUT', url: '/chunks/to-delete', headers, payload: content });

    expect((await app.inject({ method: 'HEAD', url: '/chunks/to-delete' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/chunks/to-delete' })).json()).toEqual({ deleted: true });
    expect((await app.inject({ method: 'DELETE', url: '/chunks/to-delete' })).json()).toEqual({ deleted: false });
    expect((await app.inject({ method: 'GET', url: '/chunks/to-delete' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'HEAD', url: '/chunks/to-delete' })).statusCode).toBe(404);
  });

  it('rejects missing and incorrect checksums without storing data', async () => {
    const missing = await app.inject({
      method: 'PUT',
      url: '/chunks/no-checksum',
      headers: { 'content-type': 'application/octet-stream' },
      payload: 'hello',
    });
    expect(missing.statusCode).toBe(400);

    const incorrect = await app.inject({
      method: 'PUT',
      url: '/chunks/bad-checksum',
      headers: {
        'content-type': 'application/octet-stream',
        'x-checksum': 'a'.repeat(64),
      },
      payload: 'hello',
    });
    expect(incorrect.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/chunks/bad-checksum' })).statusCode).toBe(404);
  });

  it('enforces cluster secret authentication on chunk operations when configured', async () => {
    const authDir = await mkdtemp(join(tmpdir(), 'voidshare-auth-'));
    const secret = 'super-secret-cluster-token-12345';
    const authApp = buildServer(new FilesystemChunkStore(authDir, 'node-auth', 1000), {
      clusterSecret: secret,
    });

    try {
      const content = 'auth-test-payload';
      const chunkChecksum = sha256(content);

      // 1. Missing Authorization header -> 401
      const noAuthPut = await authApp.inject({
        method: 'PUT',
        url: '/chunks/c-auth',
        headers: {
          'content-type': 'application/octet-stream',
          'x-checksum': chunkChecksum,
        },
        payload: content,
      });
      expect(noAuthPut.statusCode).toBe(401);
      expect(noAuthPut.json()).toEqual({ error: 'UNAUTHORIZED' });

      // 2. Wrong secret -> 401
      const wrongAuthGet = await authApp.inject({
        method: 'GET',
        url: '/chunks/c-auth',
        headers: {
          authorization: 'Bearer wrong-secret',
        },
      });
      expect(wrongAuthGet.statusCode).toBe(401);
      expect(wrongAuthGet.json()).toEqual({ error: 'UNAUTHORIZED' });

      // 3. Valid secret -> 200
      const validPut = await authApp.inject({
        method: 'PUT',
        url: '/chunks/c-auth',
        headers: {
          'content-type': 'application/octet-stream',
          'x-checksum': chunkChecksum,
          authorization: `Bearer ${secret}`,
        },
        payload: content,
      });
      expect(validPut.statusCode).toBe(200);

      const validGet = await authApp.inject({
        method: 'GET',
        url: '/chunks/c-auth',
        headers: {
          authorization: `Bearer ${secret}`,
        },
      });
      expect(validGet.statusCode).toBe(200);
      expect(validGet.body).toBe(content);

      const validList = await authApp.inject({
        method: 'GET',
        url: '/chunks',
        headers: {
          authorization: `Bearer ${secret}`,
        },
      });
      expect(validList.statusCode).toBe(200);
      expect(validList.json()).toEqual({ chunks: ['c-auth'] });

      // 4. Delete with valid secret -> 200
      const validDel = await authApp.inject({
        method: 'DELETE',
        url: '/chunks/c-auth',
        headers: {
          authorization: `Bearer ${secret}`,
        },
      });
      expect(validDel.statusCode).toBe(200);
      expect(validDel.json()).toEqual({ deleted: true });
    } finally {
      await authApp.close();
      await rm(authDir, { recursive: true, force: true });
    }
  });
});

