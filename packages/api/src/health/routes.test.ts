import { describe, expect, it } from 'vitest';
import { MetadataDatabase } from '../db/database.js';
import { buildApiServer } from '../server.js';
import { HealthMonitor } from './monitor.js';

describe('node health routes', () => {
  it('accepts a heartbeat and reports node health/capacity', async () => {
    const database = new MetadataDatabase();
    const monitor = new HealthMonitor(database, () => new Date('2026-10-07T10:00:00.000Z'));
    const app = buildApiServer(database, undefined, undefined, undefined, monitor);
    const heartbeat = await app.inject({
      method: 'POST',
      url: '/api/nodes/heartbeat',
      payload: { nodeId: 'node-a', endpointUrl: 'http://localhost:9001', totalCapacityBytes: 100, usedCapacityBytes: 20, activeOperations: 1 },
    });
    expect(heartbeat.statusCode).toBe(200);
    const health = await app.inject({ method: 'GET', url: '/api/nodes/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().nodes).toEqual([
      expect.objectContaining({ node_id: 'node-a', status: 'HEALTHY', used_capacity_bytes: 20 }),
    ]);
    await app.close();
    database.close();
  });

  it('rejects malformed or over-capacity heartbeats', async () => {
    const database = new MetadataDatabase();
    const app = buildApiServer(database);
    const response = await app.inject({
      method: 'POST',
      url: '/api/nodes/heartbeat',
      payload: { nodeId: '../node', endpointUrl: 'file:///tmp/node', totalCapacityBytes: 1, usedCapacityBytes: 2, activeOperations: 0 },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
    database.close();
  });

  it('enforces cluster secret authentication on heartbeat registration', async () => {
    const database = new MetadataDatabase();
    const clusterSecret = 'cluster-secret-xyz-987';
    const app = buildApiServer(database, undefined, undefined, undefined, undefined, {
      clusterSecret,
      allowedNodeIds: ['node-1'],
    });

    const validPayload = {
      nodeId: 'node-1',
      endpointUrl: 'http://localhost:9001',
      totalCapacityBytes: 1000,
      usedCapacityBytes: 100,
      activeOperations: 0,
    };

    // 1. Missing Authorization header -> 401
    const missing = await app.inject({
      method: 'POST',
      url: '/api/nodes/heartbeat',
      payload: validPayload,
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({ error: 'UNAUTHORIZED' });

    // 2. Wrong secret -> 401
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/nodes/heartbeat',
      headers: { authorization: 'Bearer wrong-secret' },
      payload: validPayload,
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: 'UNAUTHORIZED' });

    // 3. Valid secret -> 200
    const valid = await app.inject({
      method: 'POST',
      url: '/api/nodes/heartbeat',
      headers: { authorization: `Bearer ${clusterSecret}` },
      payload: validPayload,
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ acknowledged: true });

    await app.close();
    database.close();
  });

  it('rejects heartbeats from unconfigured or mismatched nodes', async () => {
    const database = new MetadataDatabase();
    database.registerStorageNode({
      nodeId: 'node-1',
      endpointUrl: 'http://192.168.1.10:9001',
      status: 'UNAVAILABLE',
    });

    const clusterSecret = 'cluster-secret-abc';
    const app = buildApiServer(database, undefined, undefined, undefined, undefined, {
      clusterSecret,
      allowedNodeIds: ['node-1'],
    });

    // 1. Unconfigured node ID -> 403
    const unknownNode = await app.inject({
      method: 'POST',
      url: '/api/nodes/heartbeat',
      headers: { authorization: `Bearer ${clusterSecret}` },
      payload: {
        nodeId: 'node-rogue',
        endpointUrl: 'http://192.168.1.99:9001',
        totalCapacityBytes: 1000,
        usedCapacityBytes: 100,
        activeOperations: 0,
      },
    });
    expect(unknownNode.statusCode).toBe(403);
    expect(unknownNode.json()).toEqual({ error: 'NODE_NOT_CONFIGURED' });

    // 2. Configured node but mismatched endpoint -> 403
    const mismatchedEndpoint = await app.inject({
      method: 'POST',
      url: '/api/nodes/heartbeat',
      headers: { authorization: `Bearer ${clusterSecret}` },
      payload: {
        nodeId: 'node-1',
        endpointUrl: 'http://192.168.1.55:9001', // different from registered 192.168.1.10
        totalCapacityBytes: 1000,
        usedCapacityBytes: 100,
        activeOperations: 0,
      },
    });
    expect(mismatchedEndpoint.statusCode).toBe(403);
    expect(mismatchedEndpoint.json()).toEqual({ error: 'ENDPOINT_MISMATCH' });

    // 3. Configured node with matching endpoint -> 200
    const matched = await app.inject({
      method: 'POST',
      url: '/api/nodes/heartbeat',
      headers: { authorization: `Bearer ${clusterSecret}` },
      payload: {
        nodeId: 'node-1',
        endpointUrl: 'http://192.168.1.10:9001',
        totalCapacityBytes: 1000,
        usedCapacityBytes: 100,
        activeOperations: 0,
      },
    });
    expect(matched.statusCode).toBe(200);
    expect(matched.json()).toEqual({ acknowledged: true });

    await app.close();
    database.close();
  });
});
