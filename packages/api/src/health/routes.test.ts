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
});
