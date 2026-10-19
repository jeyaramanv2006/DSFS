import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesystemChunkStore } from './storage.js';
import { StorageNodeHeartbeatEmitter } from './heartbeat.js';
import { buildServer } from './server.js';

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

describe('StorageNodeHeartbeatEmitter and active operations', () => {
  let tempDir: string;
  let mockCoordinator: Server;
  let coordinatorPort: number;
  let receivedHeartbeats: any[] = [];
  let authHeaders: (string | undefined)[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'voidshare-hb-'));
    receivedHeartbeats = [];
    authHeaders = [];

    await new Promise<void>((resolve) => {
      mockCoordinator = createServer((req, res) => {
        if (req.url === '/api/nodes/heartbeat' && req.method === 'POST') {
          authHeaders.push(req.headers.authorization);
          let body = '';
          req.setEncoding('utf8');
          req.on('data', (c) => { body += c; });
          req.on('end', () => {
            try {
              receivedHeartbeats.push(JSON.parse(body));
            } catch {
              receivedHeartbeats.push(body);
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ acknowledged: true }));
          });
        } else {
          res.writeHead(404).end();
        }
      });
      mockCoordinator.listen(0, '127.0.0.1', () => {
        const addr = mockCoordinator.address();
        coordinatorPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => mockCoordinator.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  });

  it('emits authenticated heartbeats with capacity and active operations', async () => {
    const store = new FilesystemChunkStore(tempDir, 'node-test-hb', 50_000);
    const content = 'heartbeat data';
    await store.putChunk('chunk-hb', Readable.from([content]), sha256(content));

    let currentOps = 3;
    const emitter = new StorageNodeHeartbeatEmitter({
      nodeId: 'node-test-hb',
      endpointUrl: 'http://127.0.0.1:9001',
      coordinatorUrl: `http://127.0.0.1:${coordinatorPort}`,
      clusterSecret: 'my-cluster-secret',
      intervalMs: 100,
      store,
      getActiveOperations: () => currentOps,
    });

    const success = await emitter.emitOnce();
    expect(success).toBe(true);
    expect(receivedHeartbeats).toHaveLength(1);
    expect(receivedHeartbeats[0]).toEqual({
      nodeId: 'node-test-hb',
      endpointUrl: 'http://127.0.0.1:9001',
      totalCapacityBytes: 50_000,
      usedCapacityBytes: content.length,
      activeOperations: 3,
    });
    expect(authHeaders[0]).toBe('Bearer my-cluster-secret');

    emitter.stop();
  });

  it('survives coordinator connection errors and timeouts without throwing', async () => {
    const store = new FilesystemChunkStore(tempDir, 'node-err', 1000);
    // Point to an unavailable port
    const emitter = new StorageNodeHeartbeatEmitter({
      nodeId: 'node-err',
      endpointUrl: 'http://127.0.0.1:9001',
      coordinatorUrl: 'http://127.0.0.1:1', // Unreachable port
      intervalMs: 50,
      store,
    });

    // Should return false and not throw
    const result = await emitter.emitOnce();
    expect(result).toBe(false);

    emitter.stop();
  });

  it('tracks active operations across concurrent requests on server', async () => {
    const store = new FilesystemChunkStore(tempDir, 'node-server-ops', 1000);
    const app = buildServer(store, { autoStartHeartbeat: false });

    // Initial health check -> activeOperations: 0
    const health0 = await app.inject({ method: 'GET', url: '/health' });
    expect(health0.json().activeOperations).toBe(0);

    // After completed operation, activeOperations returns to 0
    const put = await app.inject({
      method: 'PUT',
      url: '/chunks/c-1',
      headers: {
        'content-type': 'application/octet-stream',
        'x-checksum': sha256('abc'),
      },
      payload: 'abc',
    });
    expect(put.statusCode).toBe(200);

    const health1 = await app.inject({ method: 'GET', url: '/health' });
    expect(health1.json().activeOperations).toBe(0);

    await app.close();
  });
});
