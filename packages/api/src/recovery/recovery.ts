import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { MetadataDatabase } from '../db/database.js';
import type { StorageNodeClient } from '../services/storage-client.js';

export interface RecoveryTarget {
  nodeId: string;
  client: Pick<StorageNodeClient, 'getChunk' | 'putChunk'>;
}

export interface RecoveryReport {
  recovered: Array<{ chunkId: string; sourceNodeId: string; targetNodeId: string }>;
  skipped: string[];
}

export class RecoveryService {
  public constructor(
    private readonly database: MetadataDatabase,
    private readonly targets: readonly RecoveryTarget[],
    private readonly replicationFactor = 2,
  ) {}

  public async recoverUnderReplicated(): Promise<RecoveryReport> {
    const targetMap = new Map(this.targets.map((target) => [target.nodeId, target]));
    const healthy = new Set(this.database.listStorageNodes('HEALTHY').map((node) => node.node_id));
    const recovered: RecoveryReport['recovered'] = [];
    const skipped: string[] = [];
    for (const candidate of this.database.getRecoveryCandidates(this.replicationFactor)) {
      const activeReplicas = this.database.getConfirmedReplicas(candidate.chunk_id)
        .filter((replica) => replica.status === 'ACTIVE');
      const source = activeReplicas.find((replica) => healthy.has(replica.node_id) && targetMap.has(replica.node_id));
      if (!source) {
        skipped.push(candidate.chunk_id);
        continue;
      }
      const sourceTarget = targetMap.get(source.node_id)!;
      let payload: Buffer;
      try {
        payload = await readAndVerify(sourceTarget.client, candidate.chunk_id, candidate.checksum_sha256, candidate.size_bytes);
      } catch {
        skipped.push(candidate.chunk_id);
        continue;
      }
      const existing = new Set(activeReplicas.map((replica) => replica.node_id));
      const target = this.database.listStorageNodes('HEALTHY')
        .find((node) => !existing.has(node.node_id) && targetMap.has(node.node_id));
      if (!target) {
        skipped.push(candidate.chunk_id);
        continue;
      }
      try {
        const result = await targetMap.get(target.node_id)!.client.putChunk(
          candidate.chunk_id,
          Readable.from(payload),
          candidate.checksum_sha256,
        );
        if (result.sizeBytes !== candidate.size_bytes || result.checksumSha256.toLowerCase() !== candidate.checksum_sha256.toLowerCase()) {
          throw new Error('target checksum confirmation mismatch');
        }
        this.database.addConfirmedReplica(candidate.chunk_id, target.node_id);
        recovered.push({ chunkId: candidate.chunk_id, sourceNodeId: source.node_id, targetNodeId: target.node_id });
      } catch {
        skipped.push(candidate.chunk_id);
      }
    }
    return { recovered, skipped };
  }
}

async function readAndVerify(
  source: Pick<StorageNodeClient, 'getChunk'>,
  chunkId: string,
  checksum: string,
  expectedSize: number,
): Promise<Buffer> {
  const stream = await source.getChunk(chunkId);
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
  const payload = Buffer.concat(parts);
  if (payload.length !== expectedSize || createHash('sha256').update(payload).digest('hex') !== checksum.toLowerCase()) {
    throw new Error('source integrity check failed');
  }
  return payload;
}
