import { MetadataDatabase } from '../db/database.js';
import { ConsistentHashRing } from './ring.js';

export class PlacementService {
  public constructor(
    private readonly database: MetadataDatabase,
    private readonly virtualNodes = 128,
  ) {}

  public placeChunk(chunkId: string, count = 1, chunkSizeBytes = 0): string[] {
    const selected = this.selectNodes(chunkId, count, chunkSizeBytes);
    this.database.recordPlacement(chunkId, selected);
    return selected;
  }

  public selectNodes(chunkId: string, count = 1, chunkSizeBytes = 0): string[] {
    const healthyNodes = this.database.listStorageNodes('HEALTHY')
      .filter((node) => node.total_capacity_bytes === 0 ||
        node.used_capacity_bytes + chunkSizeBytes <= node.total_capacity_bytes)
      .map((node) => node.node_id);
    if (healthyNodes.length === 0) throw new Error('no healthy storage nodes');
    return new ConsistentHashRing(healthyNodes, this.virtualNodes).getNodesFor(chunkId, count);
  }
}
