import type { Readable } from 'node:stream';
import { MetadataDatabase } from '../db/database.js';
import type { StorageNodeClient } from '../services/storage-client.js';

export interface ReplicaReadTarget {
  nodeId: string;
  client: Pick<StorageNodeClient, 'getChunk'>;
}

export class NodeUnavailableError extends Error {
  public readonly code = 'NODE_UNAVAILABLE' as const;
  public constructor() {
    super('all replicas are unavailable');
    this.name = 'NodeUnavailableError';
  }
}

const HEALTH_ORDER: Record<string, number> = {
  HEALTHY: 0,
  RECOVERING: 1,
  UNHEALTHY: 2,
  UNAVAILABLE: 3,
};

export class ReplicaReadService {
  public constructor(
    private readonly database: MetadataDatabase,
    private readonly targets: readonly ReplicaReadTarget[],
  ) {}

  public async getChunk(chunkId: string): Promise<Readable> {
    const health = new Map(this.database.listStorageNodes().map((node) => [node.node_id, node.status]));
    const targetMap = new Map(this.targets.map((target) => [target.nodeId, target]));
    const replicas = this.database.getConfirmedReplicas(chunkId)
      .filter((replica) => replica.status === 'ACTIVE' && targetMap.has(replica.node_id))
      .sort((left, right) => (HEALTH_ORDER[health.get(left.node_id) ?? 'UNAVAILABLE'] ?? 99)
        - (HEALTH_ORDER[health.get(right.node_id) ?? 'UNAVAILABLE'] ?? 99));
    for (const replica of replicas) {
      try {
        return await targetMap.get(replica.node_id)!.client.getChunk(chunkId);
      } catch {
        // Try the next confirmed replica without exposing node details.
      }
    }
    throw new NodeUnavailableError();
  }
}
