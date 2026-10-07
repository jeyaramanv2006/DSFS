import { Readable } from 'node:stream';
import { MetadataDatabase } from '../db/database.js';
import type { StoredChunkResult, StorageNodeClient } from '../services/storage-client.js';
import { PlacementService } from '../placement/service.js';

export interface ReplicaTarget {
  nodeId: string;
  client: Pick<StorageNodeClient, 'putChunk'>;
}

export interface ReplicationResult {
  confirmedNodeIds: string[];
  failedNodeIds: string[];
}

export interface ChunkReplicator {
  replicateChunk(
    chunkId: string,
    payload: Uint8Array,
    checksumSha256: string,
    replicationFactor?: number,
  ): Promise<ReplicationResult>;
}

export class ReplicationService implements ChunkReplicator {
  public constructor(
    private readonly database: MetadataDatabase,
    private readonly placement: PlacementService,
    private readonly targets: readonly ReplicaTarget[],
  ) {}

  public async replicateChunk(
    chunkId: string,
    payload: Uint8Array,
    checksumSha256: string,
    replicationFactor = 2,
  ): Promise<ReplicationResult> {
    if (!Number.isSafeInteger(replicationFactor) || replicationFactor < 1) {
      throw new Error('replication factor must be positive');
    }
    const targetMap = new Map(this.targets.map((target) => [target.nodeId, target]));
    const candidateIds = this.placement
      .selectNodes(chunkId, this.targets.length, payload.byteLength)
      .filter((nodeId) => targetMap.has(nodeId));
    const confirmed: string[] = [];
    const failed: string[] = [];
    const initial = candidateIds.slice(0, replicationFactor);
    const initialResults = await Promise.allSettled(initial.map((nodeId) => this.write(targetMap.get(nodeId)!, chunkId, payload, checksumSha256)));
    initialResults.forEach((result, index) => {
      if (result.status === 'fulfilled') confirmed.push(initial[index]);
      else failed.push(initial[index]);
    });

    for (const nodeId of candidateIds.slice(replicationFactor)) {
      if (confirmed.length >= replicationFactor) break;
      try {
        await this.write(targetMap.get(nodeId)!, chunkId, payload, checksumSha256);
        confirmed.push(nodeId);
      } catch {
        failed.push(nodeId);
      }
    }
    this.database.recordConfirmedReplicas(chunkId, confirmed);
    if (confirmed.length < replicationFactor) {
      throw new Error(`replication failed: ${confirmed.length}/${replicationFactor} confirmed`);
    }
    return { confirmedNodeIds: confirmed, failedNodeIds: failed };
  }

  private async write(
    target: ReplicaTarget,
    chunkId: string,
    payload: Uint8Array,
    checksumSha256: string,
  ): Promise<StoredChunkResult> {
    const result = await target.client.putChunk(chunkId, Readable.from(payload), checksumSha256);
    if (result.checksumSha256.toLowerCase() !== checksumSha256.toLowerCase()) {
      throw new Error('replica checksum confirmation mismatch');
    }
    return result;
  }
}
