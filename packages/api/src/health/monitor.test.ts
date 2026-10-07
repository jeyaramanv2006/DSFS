import { describe, expect, it } from 'vitest';
import { MetadataDatabase } from '../db/database.js';
import { HealthMonitor } from './monitor.js';

describe('storage node health monitor', () => {
  it('records heartbeats and transitions stale nodes through unhealthy to unavailable', () => {
    const database = new MetadataDatabase();
    let now = new Date('2026-10-07T10:00:00.000Z');
    const monitor = new HealthMonitor(database, () => now, { unhealthyAfterMs: 10_000, unavailableAfterMs: 30_000 });
    monitor.recordHeartbeat({ nodeId: 'node-a', endpointUrl: 'http://a', totalCapacityBytes: 100, usedCapacityBytes: 12, activeOperations: 1 });
    expect(database.listStorageNodes()).toEqual([
      expect.objectContaining({ node_id: 'node-a', status: 'HEALTHY', used_capacity_bytes: 12 }),
    ]);

    now = new Date('2026-10-07T10:00:00.000Z');
    expect(monitor.refresh()).toEqual([]);
    now = new Date('2026-10-07T10:00:10.001Z');
    expect(monitor.refresh()).toEqual([{ nodeId: 'node-a', previous: 'HEALTHY', current: 'UNHEALTHY' }]);
    now = new Date('2026-10-07T10:00:30.001Z');
    expect(monitor.refresh()).toEqual([{ nodeId: 'node-a', previous: 'UNHEALTHY', current: 'UNAVAILABLE' }]);
    database.close();
  });

  it('a heartbeat restores an unavailable node to healthy and updates capacity', () => {
    const database = new MetadataDatabase();
    let now = new Date('2026-10-07T10:00:00.000Z');
    const monitor = new HealthMonitor(database, () => now, { unhealthyAfterMs: 10_000, unavailableAfterMs: 30_000 });
    monitor.recordHeartbeat({ nodeId: 'node-a', endpointUrl: 'http://a', totalCapacityBytes: 100, usedCapacityBytes: 10, activeOperations: 0 });
    now = new Date('2026-10-07T10:00:30.001Z');
    monitor.refresh();
    monitor.recordHeartbeat({ nodeId: 'node-a', endpointUrl: 'http://a', totalCapacityBytes: 200, usedCapacityBytes: 20, activeOperations: 2 });
    expect(database.listStorageNodes()[0]).toMatchObject({ status: 'HEALTHY', total_capacity_bytes: 200, used_capacity_bytes: 20, active_operations: 2 });
    database.close();
  });
});
