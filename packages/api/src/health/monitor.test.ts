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

  it('keeps boot-registered unavailable nodes unavailable until first heartbeat', () => {
    const database = new MetadataDatabase();
    database.registerStorageNode({ nodeId: 'node-1', endpointUrl: 'http://node-1:9001', status: 'UNAVAILABLE' });
    const monitor = new HealthMonitor(database, () => new Date(), { unhealthyAfterMs: 6000, unavailableAfterMs: 12000 });

    // Running refresh immediately must NOT promote node to HEALTHY
    const transitions = monitor.refresh();
    expect(transitions).toEqual([]);
    expect(database.getStorageNode('node-1')?.status).toBe('UNAVAILABLE');

    // First valid heartbeat sets it to HEALTHY
    monitor.recordHeartbeat({
      nodeId: 'node-1',
      endpointUrl: 'http://node-1:9001',
      totalCapacityBytes: 1000,
      usedCapacityBytes: 50,
      activeOperations: 0,
    });
    expect(database.getStorageNode('node-1')?.status).toBe('HEALTHY');
    database.close();
  });

  it('manages timer start and stop lifecycle correctly', async () => {
    const database = new MetadataDatabase();
    const monitor = new HealthMonitor(database);
    expect(monitor.isStarted()).toBe(false);

    monitor.start(50);
    expect(monitor.isStarted()).toBe(true);

    // Multiple calls to start are idempotent
    monitor.start(50);
    expect(monitor.isStarted()).toBe(true);

    monitor.stop();
    expect(monitor.isStarted()).toBe(false);
    database.close();
  });

  it('records cluster transition events when node state changes', () => {
    const database = new MetadataDatabase();
    let now = new Date('2026-10-07T10:00:00.000Z');
    const monitor = new HealthMonitor(database, () => now, { unhealthyAfterMs: 5000, unavailableAfterMs: 15000 });

    // 1. Initial heartbeat for unknown node -> NODE_REGISTERED
    monitor.recordHeartbeat({
      nodeId: 'node-x',
      endpointUrl: 'http://node-x:9001',
      totalCapacityBytes: 100,
      usedCapacityBytes: 10,
      activeOperations: 0,
    });
    let events = database.listClusterEvents({ nodeId: 'node-x' });
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('NODE_REGISTERED');
    expect(events[0].severity).toBe('INFO');

    // 2. Node ages past unhealthy threshold -> NODE_UNHEALTHY
    now = new Date('2026-10-07T10:00:06.000Z');
    monitor.refresh();
    events = database.listClusterEvents({ nodeId: 'node-x' });
    expect(events).toHaveLength(2);
    expect(events[0].event_type).toBe('NODE_UNHEALTHY');
    expect(events[0].severity).toBe('WARN');

    // 3. Node ages past unavailable threshold -> NODE_UNAVAILABLE
    now = new Date('2026-10-07T10:00:16.000Z');
    monitor.refresh();
    events = database.listClusterEvents({ nodeId: 'node-x' });
    expect(events).toHaveLength(3);
    expect(events[0].event_type).toBe('NODE_UNAVAILABLE');
    expect(events[0].severity).toBe('ERROR');

    // 4. Node returns and heartbeats -> NODE_RECOVERED
    now = new Date('2026-10-07T10:00:20.000Z');
    monitor.recordHeartbeat({
      nodeId: 'node-x',
      endpointUrl: 'http://node-x:9001',
      totalCapacityBytes: 100,
      usedCapacityBytes: 10,
      activeOperations: 0,
    });
    events = database.listClusterEvents({ nodeId: 'node-x' });
    expect(events).toHaveLength(4);
    expect(events[0].event_type).toBe('NODE_RECOVERED');
    expect(events[0].severity).toBe('INFO');

    // 5. Rejected heartbeat is recorded
    now = new Date('2026-10-07T10:00:21.000Z');
    monitor.recordRejectedHeartbeat({ nodeId: 'node-x', reason: 'ENDPOINT_MISMATCH' });
    events = database.listClusterEvents({ nodeId: 'node-x' });
    expect(events).toHaveLength(5);
    expect(events[0].event_type).toBe('HEARTBEAT_REJECTED');
    expect(events[0].severity).toBe('WARN');

    database.close();
  });
});
