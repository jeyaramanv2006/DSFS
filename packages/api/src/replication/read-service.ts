import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
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

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) {
    parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

export class ReplicaReadService {
  public constructor(
    private readonly database: MetadataDatabase,
    private readonly targets: readonly ReplicaReadTarget[],
  ) {}

  public async getChunk(chunkId: string): Promise<Readable> {
    const chunkRecord = this.database.getChunk(chunkId);
    const expectedChecksum = chunkRecord?.checksum_sha256;
    const fileId = chunkRecord?.file_id ?? chunkId.split('-')[0];

    const health = new Map(this.database.listStorageNodes().map((node) => [node.node_id, node.status]));
    const targetMap = new Map(this.targets.map((target) => [target.nodeId, target]));
    const replicas = this.database.getConfirmedReplicas(chunkId)
      .filter((replica) => replica.status === 'ACTIVE' && targetMap.has(replica.node_id))
      .sort((left, right) => (HEALTH_ORDER[health.get(left.node_id) ?? 'UNAVAILABLE'] ?? 99)
        - (HEALTH_ORDER[health.get(right.node_id) ?? 'UNAVAILABLE'] ?? 99));

    const failedNodes: string[] = [];

    for (const replica of replicas) {
      try {
        const stream = await targetMap.get(replica.node_id)!.client.getChunk(chunkId);
        let returnStream: Readable = stream;

        if (expectedChecksum) {
          const payload = await streamToBuffer(stream);
          const actualChecksum = createHash('sha256').update(payload).digest('hex');
          if (actualChecksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
            throw new Error(`checksum mismatch on replica ${replica.node_id}`);
          }
          returnStream = Readable.from(payload);
        }

        if (failedNodes.length > 0) {
          this.database.recordClusterEvent({
            eventType: 'READ_FAILOVER_SUCCEEDED',
            severity: 'INFO',
            nodeId: replica.node_id,
            fileId,
            details: {
              chunkId,
              failedNodes,
              succeededNode: replica.node_id,
            },
          });
        }

        return returnStream;
      } catch {
        failedNodes.push(replica.node_id);
      }
    }

    this.database.recordClusterEvent({
      eventType: 'CHUNK_UNAVAILABLE',
      severity: 'ERROR',
      fileId,
      details: {
        chunkId,
        attemptedNodes: replicas.map((r) => r.node_id),
        failedNodes,
      },
    });

    throw new NodeUnavailableError();
  }
}
