import { MetadataDatabase, type StorageNodeRecord } from '../db/database.js';

export interface HeartbeatInput {
  nodeId: string;
  endpointUrl: string;
  totalCapacityBytes: number;
  usedCapacityBytes: number;
  activeOperations: number;
}

export interface HealthTransition {
  nodeId: string;
  previous: string;
  current: string;
}

interface HealthThresholds {
  unhealthyAfterMs: number;
  unavailableAfterMs: number;
}

export class HealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private isTicking = false;
  private isRunning = false;

  public constructor(
    private readonly database: MetadataDatabase,
    private readonly clock: () => Date = () => new Date(),
    private readonly thresholds: HealthThresholds = { unhealthyAfterMs: 15_000, unavailableAfterMs: 60_000 },
  ) {}

  public start(intervalMs = 2000): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.timer = setInterval(() => {
      if (this.isTicking) return;
      this.isTicking = true;
      try {
        this.refresh();
      } catch (error) {
        try {
          this.database.recordClusterEvent({
            eventType: 'MONITOR_ERROR',
            severity: 'ERROR',
            details: { message: error instanceof Error ? error.message : String(error) },
            createdAt: this.clock().toISOString(),
          });
        } catch {
          // Prevent logging failure from crashing loop
        }
      } finally {
        this.isTicking = false;
      }
    }, intervalMs);
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public isStarted(): boolean {
    return this.isRunning;
  }

  public recordHeartbeat(input: HeartbeatInput): void {
    if (!Number.isSafeInteger(input.totalCapacityBytes) || input.totalCapacityBytes < 0 ||
      !Number.isSafeInteger(input.usedCapacityBytes) || input.usedCapacityBytes < 0 ||
      !Number.isSafeInteger(input.activeOperations) || input.activeOperations < 0) {
      throw new Error('invalid heartbeat capacity values');
    }

    const existing = this.database.getStorageNode(input.nodeId);
    const previousStatus = existing?.status;
    const nowIso = this.clock().toISOString();

    this.database.registerStorageNode({ ...input, status: 'HEALTHY', heartbeatAt: nowIso });

    if (!existing) {
      this.database.recordClusterEvent({
        eventType: 'NODE_REGISTERED',
        severity: 'INFO',
        nodeId: input.nodeId,
        details: { endpoint: input.endpointUrl },
        createdAt: nowIso,
      });
    } else if (previousStatus !== 'HEALTHY') {
      this.database.recordClusterEvent({
        eventType: 'NODE_RECOVERED',
        severity: 'INFO',
        nodeId: input.nodeId,
        details: { previous: previousStatus, current: 'HEALTHY' },
        createdAt: nowIso,
      });
    }
  }

  public refresh(): HealthTransition[] {
    const now = this.clock().getTime();
    const nowIso = this.clock().toISOString();
    const transitions: HealthTransition[] = [];
    for (const node of this.database.listStorageNodes()) {
      const age = Math.max(0, now - Date.parse(node.last_heartbeat));
      const current = age >= this.thresholds.unavailableAfterMs
        ? 'UNAVAILABLE'
        : age >= this.thresholds.unhealthyAfterMs ? 'UNHEALTHY' : 'HEALTHY';
      if (current !== node.status) {
        this.database.setNodeStatus(node.node_id, current);
        transitions.push({ nodeId: node.node_id, previous: node.status, current });

        const eventType = current === 'UNAVAILABLE'
          ? 'NODE_UNAVAILABLE'
          : current === 'UNHEALTHY'
            ? 'NODE_UNHEALTHY'
            : 'NODE_RECOVERED';
        const severity = current === 'UNAVAILABLE' ? 'ERROR' : current === 'UNHEALTHY' ? 'WARN' : 'INFO';

        this.database.recordClusterEvent({
          eventType,
          severity,
          nodeId: node.node_id,
          details: { previous: node.status, current, ageMs: age },
          createdAt: nowIso,
        });
      }
    }
    return transitions;
  }

  public recordRejectedHeartbeat(input: {
    nodeId?: string;
    endpointUrl?: string;
    reason: string;
  }): void {
    this.database.recordClusterEvent({
      eventType: 'HEARTBEAT_REJECTED',
      severity: 'WARN',
      nodeId: input.nodeId,
      details: { reason: input.reason, endpoint: input.endpointUrl },
      createdAt: this.clock().toISOString(),
    });
  }

  public listNodes(): StorageNodeRecord[] {
    return this.database.listStorageNodes();
  }

  public getStorageNode(nodeId: string): StorageNodeRecord | undefined {
    return this.database.getStorageNode(nodeId);
  }
}
