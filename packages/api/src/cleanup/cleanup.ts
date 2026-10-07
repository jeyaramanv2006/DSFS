import { MetadataDatabase } from '../db/database.js';
import type { StorageMaintenanceClient } from '../services/storage-client.js';

export interface CleanupTarget {
  nodeId: string;
  client: Pick<StorageMaintenanceClient, 'deleteChunk'>;
}

export interface CleanupReport {
  claimedTransfers: string[];
  deletedTransfers: string[];
  orphanedReplicas: Array<{ chunkId: string; nodeId: string }>;
}

export class ExpirationSweeper {
  public constructor(
    private readonly database: MetadataDatabase,
    private readonly targets: readonly CleanupTarget[],
  ) {}

  public async sweep(now = new Date()): Promise<CleanupReport> {
    const claimed = this.database.claimDeletableTransfers(now);
    const targetMap = new Map(this.targets.map((target) => [target.nodeId, target]));
    const orphanedReplicas: CleanupReport['orphanedReplicas'] = [];

    for (const transfer of claimed) {
      const deletionTasks = this.database.getDeletionChunks(transfer.file_id).flatMap((chunk) =>
        chunk.replicas
          .filter((replica) => replica.status !== 'DELETED')
          .map((replica) => ({ chunkId: chunk.chunk_id, nodeId: replica.node_id })),
      );
      const results = await Promise.allSettled(deletionTasks.map(async (task) => {
        const target = targetMap.get(task.nodeId);
        if (!target) throw new Error('storage target unavailable');
        await target.client.deleteChunk(task.chunkId);
        return task;
      }));
      results.forEach((result, index) => {
        const task = deletionTasks[index];
        if (result.status === 'fulfilled') {
          this.database.markReplicaDeleted(task.chunkId, task.nodeId);
        } else {
          this.database.markReplicaOrphanedPendingDelete(task.chunkId, task.nodeId);
          orphanedReplicas.push(task);
        }
      });
    }

    const deletedTransfers = claimed
      .filter((transfer) => this.database.finalizeTransferDeletion(transfer.file_id))
      .map((transfer) => transfer.file_id);
    return {
      claimedTransfers: claimed.map((transfer) => transfer.file_id),
      deletedTransfers,
      orphanedReplicas,
    };
  }
}

export interface ReconciliationTarget {
  nodeId: string;
  client: Pick<StorageMaintenanceClient, 'deleteChunk' | 'listChunks'>;
}

export interface ReconciliationReport {
  deletedOrphans: Array<{ nodeId: string; chunkId: string }>;
  failedDeletes: Array<{ nodeId: string; chunkId: string }>;
}

export class StorageReconciler {
  public constructor(
    private readonly database: MetadataDatabase,
    private readonly targets: readonly ReconciliationTarget[],
  ) {}

  public async reconcile(): Promise<ReconciliationReport> {
    const deletedOrphans: ReconciliationReport['deletedOrphans'] = [];
    const failedDeletes: ReconciliationReport['failedDeletes'] = [];
    for (const target of this.targets) {
      const active = new Set(this.database.getActiveChunkIdsForNode(target.nodeId));
      const pending = new Set(this.database.getPendingDeletionChunkIdsForNode(target.nodeId));
      const listed = await target.client.listChunks();
      const candidates = listed.filter((chunkId) => !active.has(chunkId) || pending.has(chunkId));
      const results = await Promise.allSettled(candidates.map(async (chunkId) => {
        await target.client.deleteChunk(chunkId);
        return chunkId;
      }));
      results.forEach((result, index) => {
        const chunkId = candidates[index];
        if (result.status === 'fulfilled') {
          this.database.markReplicaDeleted(chunkId, target.nodeId);
          deletedOrphans.push({ nodeId: target.nodeId, chunkId });
        } else {
          this.database.markReplicaOrphanedPendingDelete(chunkId, target.nodeId);
          failedDeletes.push({ nodeId: target.nodeId, chunkId });
        }
      });
    }
    return { deletedOrphans, failedDeletes };
  }
}
