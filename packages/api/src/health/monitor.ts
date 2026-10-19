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
      } catch {
        // Prevent transient errors from crashing monitor loop
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
    this.database.registerStorageNode({ ...input, status: 'HEALTHY', heartbeatAt: this.clock().toISOString() });
  }

  public refresh(): HealthTransition[] {
    const now = this.clock().getTime();
    const transitions: HealthTransition[] = [];
    for (const node of this.database.listStorageNodes()) {
      const age = Math.max(0, now - Date.parse(node.last_heartbeat));
      const current = age >= this.thresholds.unavailableAfterMs
        ? 'UNAVAILABLE'
        : age >= this.thresholds.unhealthyAfterMs ? 'UNHEALTHY' : 'HEALTHY';
      if (current !== node.status) {
        this.database.setNodeStatus(node.node_id, current);
        transitions.push({ nodeId: node.node_id, previous: node.status, current });
      }
    }
    return transitions;
  }

  public listNodes(): StorageNodeRecord[] {
    return this.database.listStorageNodes();
  }

  public getStorageNode(nodeId: string): StorageNodeRecord | undefined {
    return this.database.getStorageNode(nodeId);
  }
}
