import Database from 'better-sqlite3';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFileId, createToken, hashToken } from '../services/tokens.js';
import type { StoredChunkResult } from '../services/storage-client.js';

export interface CreateTransferInput {
  authToken: string;
  totalSizeBytes: number;
  chunkCount: number;
  chunkSizeBytes: number;
  encryptedFileName: string | null;
  ttlSeconds: number;
  maxDownloads: number;
}

export interface CreatedTransfer {
  fileId: string;
  status: 'CREATING';
  expiresAt: string;
  uploadToken: string;
}

export interface TransferRow {
  file_id: string;
  capability_hash: string;
  upload_session_hash: string;
  total_size_bytes: number;
  chunk_count: number;
  chunk_size_bytes: number;
  status: string;
  expires_at: string;
  download_token_hash: string | null;
  download_token_expires_at: string | null;
  download_lease_until: string | null;
  download_count: number;
  max_downloads: number;
  created_at: string;
  original_name_encrypted: string | null;
}

export interface DownloadLease {
  transfer: TransferRow;
  downloadToken: string;
  downloadTokenExpiresAt: string;
}

export type AccessInspection = 'INVALID' | 'AVAILABLE' | 'IN_PROGRESS' | 'GONE';

export interface StorageNodeRecord {
  node_id: string;
  endpoint_url: string;
  status: string;
  total_capacity_bytes: number;
  used_capacity_bytes: number;
  active_operations: number;
  last_heartbeat: string;
}

export interface DeletionChunk {
  chunk_id: string;
  replicas: Array<{ node_id: string; status: string }>;
}

export type EventSeverity = 'INFO' | 'WARN' | 'ERROR';

export interface RecordClusterEventInput {
  id?: string;
  eventType: string;
  severity?: EventSeverity;
  nodeId?: string;
  fileId?: string;
  details?: Record<string, unknown> | string;
  createdAt?: string;
}

export interface ClusterEventRow {
  id: string;
  event_type: string;
  severity: EventSeverity;
  node_id: string | null;
  file_id: string | null;
  details: string | null;
  created_at: string;
}

export interface ClusterOverview {
  totalNodes: number;
  healthyNodes: number;
  unhealthyNodes: number;
  unavailableNodes: number;
  totalCapacityBytes: number;
  usedCapacityBytes: number;
  storedChunkCount: number;
  activeReplicaCount: number;
  underReplicatedChunkCount: number;
}

export interface ClusterNodeInfo {
  nodeId: string;
  status: string;
  lastHeartbeat: string;
  lastHeartbeatAgeMs: number;
  totalCapacityBytes: number;
  usedCapacityBytes: number;
  activeOperations: number;
  storedChunkCount: number;
  replicaCount: number;
}

export interface ClusterTransferSummary {
  fileId: string;
  status: string;
  chunkCount: number;
  chunkSizeBytes: number;
  totalSizeBytes: number;
  downloadCount: number;
  maxDownloads: number;
  createdAt: string;
  expiresAt: string;
  isDegraded: boolean;
}

export interface ClusterChunkReplicaInfo {
  nodeId: string;
  status: string;
  nodeStatus: string;
}

export interface ClusterChunkDetail {
  chunkId: string;
  chunkIndex: number;
  sizeBytes: number;
  checksumSha256: string;
  status: string;
  expectedReplicaCount: number;
  activeReplicaCount: number;
  replicas: ClusterChunkReplicaInfo[];
}

export interface ClusterTransferDetail {
  fileId: string;
  status: string;
  totalSizeBytes: number;
  chunkCount: number;
  createdAt: string;
  expiresAt: string;
  chunks: ClusterChunkDetail[];
}

const DEFAULT_SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

function hashesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export class MetadataDatabase {
  public readonly db: Database.Database;

  public constructor(
    filePath = ':memory:',
    schemaPath = DEFAULT_SCHEMA_PATH,
  ) {
    this.db = new Database(filePath);
    this.db.pragma('foreign_keys = ON');
    this.migrate(schemaPath);
  }

  public migrate(schemaPath = DEFAULT_SCHEMA_PATH): void {
    this.db.exec(readFileSync(schemaPath, 'utf8'));
  }

  public createTransfer(input: CreateTransferInput): CreatedTransfer {
    const fileId = createFileId();
    const uploadToken = createToken();
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
    const capabilityHash = hashToken(input.authToken);

    const existing = this.db.prepare('SELECT file_id FROM transfers WHERE capability_hash = ?').get(capabilityHash);
    if (existing) {
      throw new Error('DUPLICATE_CAPABILITY');
    }

    this.db.prepare(`
      INSERT INTO transfers (
        file_id, capability_hash, upload_session_hash, original_name_encrypted,
        total_size_bytes, chunk_count, chunk_size_bytes, status,
        max_downloads, expires_at
      ) VALUES (@fileId, @capabilityHash, @uploadSessionHash, @encryptedFileName,
        @totalSizeBytes, @chunkCount, @chunkSizeBytes, 'CREATING',
        @maxDownloads, @expiresAt)
    `).run({
      fileId,
      capabilityHash,
      uploadSessionHash: hashToken(uploadToken),
      encryptedFileName: input.encryptedFileName,
      totalSizeBytes: input.totalSizeBytes,
      chunkCount: input.chunkCount,
      chunkSizeBytes: input.chunkSizeBytes,
      maxDownloads: input.maxDownloads,
      expiresAt,
    });

    return { fileId, status: 'CREATING', expiresAt, uploadToken };
  }

  public getTransfer(fileId: string): TransferRow | undefined {
    return this.db.prepare('SELECT * FROM transfers WHERE file_id = ?').get(fileId) as TransferRow | undefined;
  }

  public resolveTransferByCapability(capabilityHash: string): TransferRow | 'AMBIGUOUS' | undefined {
    const rows = this.db.prepare(
      'SELECT * FROM transfers WHERE capability_hash = ?',
    ).all(capabilityHash) as TransferRow[];

    if (rows.length === 0) {
      return undefined;
    }
    if (rows.length > 1) {
      return 'AMBIGUOUS';
    }
    return rows[0];
  }

  public recordStoredChunk(fileId: string, chunkIndex: number, result: StoredChunkResult): { chunkId: string } {
    const chunkId = `${fileId}-${chunkIndex}`;
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO chunks (chunk_id, file_id, chunk_index, size_bytes, checksum_sha256, status)
        VALUES (?, ?, ?, ?, ?, 'STORED')
        ON CONFLICT(file_id, chunk_index) DO UPDATE SET
          size_bytes = excluded.size_bytes,
          checksum_sha256 = excluded.checksum_sha256,
          status = 'STORED'
      `).run(chunkId, fileId, chunkIndex, result.sizeBytes, result.checksumSha256);
      this.db.prepare(`
        UPDATE transfers SET status = 'UPLOADING'
        WHERE file_id = ? AND status = 'CREATING'
      `).run(fileId);
    });
    transaction();
    return { chunkId };
  }

  public recordPendingChunk(fileId: string, chunkIndex: number, result: StoredChunkResult): { chunkId: string } {
    const chunkId = `${fileId}-${chunkIndex}`;
    this.db.prepare(`
      INSERT INTO chunks (chunk_id, file_id, chunk_index, size_bytes, checksum_sha256, status)
      VALUES (?, ?, ?, ?, ?, 'PENDING')
      ON CONFLICT(file_id, chunk_index) DO UPDATE SET
        size_bytes = excluded.size_bytes,
        checksum_sha256 = excluded.checksum_sha256,
        status = 'PENDING'
    `).run(chunkId, fileId, chunkIndex, result.sizeBytes, result.checksumSha256);
    return { chunkId };
  }

  public markStoredChunk(fileId: string, chunkIndex: number, result: StoredChunkResult): { chunkId: string } {
    const chunkId = `${fileId}-${chunkIndex}`;
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE chunks SET size_bytes = ?, checksum_sha256 = ?, status = 'STORED'
        WHERE file_id = ? AND chunk_index = ?
      `).run(result.sizeBytes, result.checksumSha256, fileId, chunkIndex);
      this.db.prepare(`
        UPDATE transfers SET status = 'UPLOADING'
        WHERE file_id = ? AND status = 'CREATING'
      `).run(fileId);
    })();
    return { chunkId };
  }

  public countStoredChunks(fileId: string): number {
    return this.db.prepare(
      "SELECT count(*) AS count FROM chunks WHERE file_id = ? AND status = 'STORED'",
    ).pluck().get(fileId) as number;
  }

  public getStoredChunkIndices(fileId: string): number[] {
    return this.db.prepare(
      "SELECT chunk_index FROM chunks WHERE file_id = ? AND status = 'STORED' ORDER BY chunk_index",
    ).pluck().all(fileId) as number[];
  }

  public getChunk(chunkId: string): {
    chunk_id: string;
    file_id: string;
    chunk_index: number;
    size_bytes: number;
    checksum_sha256: string;
    status: string;
  } | undefined {
    return this.db.prepare('SELECT * FROM chunks WHERE chunk_id = ?').get(chunkId) as {
      chunk_id: string;
      file_id: string;
      chunk_index: number;
      size_bytes: number;
      checksum_sha256: string;
      status: string;
    } | undefined;
  }

  public registerStorageNode(input: {
    nodeId: string;
    endpointUrl: string;
    status: string;
    totalCapacityBytes?: number;
    usedCapacityBytes?: number;
    activeOperations?: number;
    heartbeatAt?: string;
  }): void {
    const defaultHeartbeat = input.status === 'UNAVAILABLE'
      ? '1970-01-01T00:00:00.000Z'
      : new Date().toISOString();
    this.db.prepare(`
      INSERT INTO storage_nodes (
        node_id, endpoint_url, status, total_capacity_bytes,
        used_capacity_bytes, active_operations, last_heartbeat
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        endpoint_url = excluded.endpoint_url,
        status = excluded.status,
        total_capacity_bytes = excluded.total_capacity_bytes,
        used_capacity_bytes = excluded.used_capacity_bytes,
        active_operations = excluded.active_operations,
        last_heartbeat = excluded.last_heartbeat
    `).run(
      input.nodeId,
      input.endpointUrl,
      input.status,
      input.totalCapacityBytes ?? 0,
      input.usedCapacityBytes ?? 0,
      input.activeOperations ?? 0,
      input.heartbeatAt ?? defaultHeartbeat,
    );
  }

  public setNodeStatus(nodeId: string, status: string): void {
    this.db.prepare('UPDATE storage_nodes SET status = ? WHERE node_id = ?').run(status, nodeId);
  }

  public getStorageNode(nodeId: string): StorageNodeRecord | undefined {
    return this.db.prepare('SELECT * FROM storage_nodes WHERE node_id = ?').get(nodeId) as StorageNodeRecord | undefined;
  }

  public listStorageNodes(status?: string): StorageNodeRecord[] {
    if (status === undefined) {
      return this.db.prepare('SELECT * FROM storage_nodes ORDER BY node_id').all() as StorageNodeRecord[];
    }
    return this.db.prepare('SELECT * FROM storage_nodes WHERE status = ? ORDER BY node_id').all(status) as StorageNodeRecord[];
  }

  public recordPlacement(chunkId: string, nodeIds: readonly string[]): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM chunk_placements WHERE chunk_id = ?').run(chunkId);
      const insert = this.db.prepare(`
        INSERT INTO chunk_placements (chunk_id, node_id, placement_rank)
        VALUES (?, ?, ?)
      `);
      nodeIds.forEach((nodeId, rank) => insert.run(chunkId, nodeId, rank));
    });
    transaction();
  }

  public getPlacement(chunkId: string): Array<{ node_id: string; placement_rank: number }> {
    return this.db.prepare(`
      SELECT node_id, placement_rank FROM chunk_placements
      WHERE chunk_id = ? ORDER BY placement_rank
    `).all(chunkId) as Array<{ node_id: string; placement_rank: number }>;
  }

  public recordConfirmedReplicas(chunkId: string, nodeIds: readonly string[]): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM chunk_replicas WHERE chunk_id = ?').run(chunkId);
      const insert = this.db.prepare(`
        INSERT INTO chunk_replicas (replica_id, chunk_id, node_id, status)
        VALUES (?, ?, ?, 'ACTIVE')
      `);
      nodeIds.forEach((nodeId) => insert.run(createFileId(), chunkId, nodeId));
    });
    transaction();
  }

  public getConfirmedReplicas(chunkId: string): Array<{ node_id: string; status: string }> {
    return this.db.prepare(`
      SELECT node_id, status FROM chunk_replicas
      WHERE chunk_id = ? ORDER BY rowid
    `).all(chunkId) as Array<{ node_id: string; status: string }>;
  }

  public claimDeletableTransfers(now = new Date(), staleUploadMs = 30 * 60_000): TransferRow[] {
    const nowIso = now.toISOString();
    const staleBefore = new Date(now.getTime() - staleUploadMs).toISOString();
    return this.db.transaction(() => {
      const candidates = this.db.prepare(`
        SELECT * FROM transfers
        WHERE (
          (expires_at <= ? AND status IN ('READY', 'DOWNLOADING', 'EXPIRED', 'CONSUMED'))
          OR status IN ('CONSUMED', 'DELETING')
          OR (status IN ('CREATING', 'UPLOADING', 'FAILED') AND created_at <= ?)
        )
        AND NOT (status = 'DOWNLOADING' AND download_lease_until > ?)
      `).all(nowIso, staleBefore, nowIso) as TransferRow[];
      const claim = this.db.prepare(`
        UPDATE transfers
        SET status = 'DELETING', download_token_hash = NULL,
            download_token_expires_at = NULL, download_lease_until = NULL
        WHERE file_id = ?
      `);
      candidates.forEach((transfer) => claim.run(transfer.file_id));
      return candidates.map((transfer) => ({ ...transfer, status: 'DELETING' }));
    })();
  }

  public getDeletionChunks(fileId: string): DeletionChunk[] {
    const rows = this.db.prepare(`
      SELECT c.chunk_id, r.node_id, r.status AS replica_status
      FROM chunks c LEFT JOIN chunk_replicas r ON r.chunk_id = c.chunk_id
      WHERE c.file_id = ? AND c.status IN ('STORED', 'PENDING')
      ORDER BY c.chunk_id, r.rowid
    `).all(fileId) as Array<{ chunk_id: string; node_id: string | null; replica_status: string | null }>;
    const chunks = new Map<string, DeletionChunk>();
    for (const row of rows) {
      const chunk = chunks.get(row.chunk_id) ?? { chunk_id: row.chunk_id, replicas: [] };
      if (row.node_id && row.replica_status) chunk.replicas.push({ node_id: row.node_id, status: row.replica_status });
      chunks.set(row.chunk_id, chunk);
    }
    return [...chunks.values()];
  }

  public markReplicaDeleted(chunkId: string, nodeId: string): void {
    this.db.prepare(`
      UPDATE chunk_replicas SET status = 'DELETED'
      WHERE chunk_id = ? AND node_id = ?
    `).run(chunkId, nodeId);
  }

  public markReplicaOrphanedPendingDelete(chunkId: string, nodeId: string): void {
    this.db.prepare(`
      UPDATE chunk_replicas SET status = 'ORPHANED_PENDING_DELETE'
      WHERE chunk_id = ? AND node_id = ?
    `).run(chunkId, nodeId);
  }

  public finalizeTransferDeletion(fileId: string): boolean {
    return this.db.transaction(() => {
      const pending = this.db.prepare(`
        SELECT COUNT(*) FROM chunk_replicas r
        JOIN chunks c ON c.chunk_id = r.chunk_id
        WHERE c.file_id = ? AND r.status NOT IN ('DELETED')
      `).pluck().get(fileId) as number;
      if (pending !== 0) return false;
      this.db.prepare("UPDATE chunks SET status = 'DELETED' WHERE file_id = ?").run(fileId);
      const result = this.db.prepare(`
        UPDATE transfers SET status = 'DELETED', download_token_hash = NULL,
          download_token_expires_at = NULL, download_lease_until = NULL
        WHERE file_id = ? AND status = 'DELETING'
      `).run(fileId);
      return result.changes === 1;
    })();
  }

  public getActiveChunkIdsForNode(nodeId: string): string[] {
    return this.db.prepare(`
      SELECT r.chunk_id FROM chunk_replicas r
      JOIN chunks c ON c.chunk_id = r.chunk_id
      JOIN transfers t ON t.file_id = c.file_id
      WHERE r.node_id = ? AND r.status = 'ACTIVE' AND c.status = 'STORED'
        AND t.status NOT IN ('DELETING', 'DELETED', 'EXPIRED', 'CONSUMED')
    `).pluck().all(nodeId) as string[];
  }

  public getPendingDeletionChunkIdsForNode(nodeId: string): string[] {
    return this.db.prepare(`
      SELECT chunk_id FROM chunk_replicas
      WHERE node_id = ? AND status = 'ORPHANED_PENDING_DELETE'
    `).pluck().all(nodeId) as string[];
  }

  public getRecoveryCandidates(replicationFactor = 2): Array<{
    chunk_id: string;
    size_bytes: number;
    checksum_sha256: string;
    transfer_status: string;
    active_replica_count: number;
  }> {
    return this.db.prepare(`
      SELECT c.chunk_id, c.size_bytes, c.checksum_sha256,
             t.status AS transfer_status,
             COUNT(CASE WHEN r.status = 'ACTIVE' AND s.status = 'HEALTHY' THEN 1 END) AS active_replica_count
      FROM chunks c
      JOIN transfers t ON t.file_id = c.file_id
      LEFT JOIN chunk_replicas r ON r.chunk_id = c.chunk_id
      LEFT JOIN storage_nodes s ON s.node_id = r.node_id
      WHERE c.status = 'STORED'
        AND t.status NOT IN ('DELETING', 'EXPIRED', 'DELETED')
      GROUP BY c.chunk_id
      HAVING active_replica_count < ?
      ORDER BY c.chunk_id
    `).all(replicationFactor) as Array<{
      chunk_id: string;
      size_bytes: number;
      checksum_sha256: string;
      transfer_status: string;
      active_replica_count: number;
    }>;
  }

  public addConfirmedReplica(chunkId: string, nodeId: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO chunk_replicas (replica_id, chunk_id, node_id, status)
      VALUES (?, ?, ?, 'ACTIVE')
    `).run(createFileId(), chunkId, nodeId);
  }

  public finalizeTransfer(fileId: string): TransferRow | undefined {
    const transfer = this.getTransfer(fileId);
    if (!transfer || this.countStoredChunks(fileId) !== transfer.chunk_count) {
      return undefined;
    }
    this.db.prepare(`
      UPDATE transfers SET status = 'READY'
      WHERE file_id = ? AND status IN ('CREATING', 'UPLOADING')
    `).run(fileId);
    return this.getTransfer(fileId);
  }

  public getStoredChunks(fileId: string): Array<{ chunk_index: number; size_bytes: number; checksum_sha256: string }> {
    return this.db.prepare(`
      SELECT chunk_index, size_bytes, checksum_sha256
      FROM chunks WHERE file_id = ? AND status = 'STORED' ORDER BY chunk_index
    `).all(fileId) as Array<{ chunk_index: number; size_bytes: number; checksum_sha256: string }>;
  }

  public acquireDownloadLease(
    fileId: string,
    capabilityHash: string,
    now = new Date(),
  ): DownloadLease | undefined {
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + 60_000).toISOString();
    const downloadToken = createToken();
    const result = this.db.transaction(() => {
      const update = this.db.prepare(`
        UPDATE transfers
        SET status = 'DOWNLOADING', download_token_hash = ?,
            download_token_expires_at = ?, download_lease_until = ?
        WHERE file_id = ? AND capability_hash = ? AND expires_at > ?
          AND download_count < max_downloads
          AND (status = 'READY' OR (status = 'DOWNLOADING' AND download_lease_until <= ?))
      `).run(hashToken(downloadToken), leaseUntil, leaseUntil, fileId, capabilityHash, nowIso, nowIso);
      if (update.changes !== 1) return undefined;
      return { transfer: this.getTransfer(fileId)!, downloadToken, downloadTokenExpiresAt: leaseUntil };
    })();
    return result;
  }

  public completeDownload(fileId: string, tokenHash: string, now = new Date()): TransferRow | undefined {
    const nowIso = now.toISOString();
    return this.db.transaction(() => {
      const transfer = this.getTransfer(fileId);
      if (!transfer || transfer.status !== 'DOWNLOADING' ||
        !transfer.download_token_hash || !hashesEqual(transfer.download_token_hash, tokenHash) ||
        !transfer.download_lease_until || transfer.download_lease_until <= nowIso) {
        return undefined;
      }
      const nextCount = transfer.download_count + 1;
      const update = this.db.prepare(`
        UPDATE transfers
        SET download_count = ?, status = ?, download_token_hash = NULL,
            download_token_expires_at = NULL, download_lease_until = NULL
        WHERE file_id = ? AND status = 'DOWNLOADING' AND download_token_hash = ?
      `).run(nextCount, nextCount >= transfer.max_downloads ? 'CONSUMED' : 'READY', fileId, tokenHash);
      if (update.changes !== 1) return undefined;
      return this.getTransfer(fileId);
    })();
  }

  public inspectAccess(fileId: string, capabilityHash: string, now = new Date()): AccessInspection {
    const transfer = this.getTransfer(fileId);
    if (!transfer || !hashesEqual(capabilityHash, transfer.capability_hash)) return 'INVALID';
    const nowIso = now.toISOString();
    if (transfer.expires_at <= nowIso ||
      ['EXPIRED', 'CONSUMED', 'DELETING', 'DELETED'].includes(transfer.status) ||
      transfer.download_count >= transfer.max_downloads) return 'GONE';
    if (transfer.status === 'DOWNLOADING' && transfer.download_lease_until && transfer.download_lease_until > nowIso) {
      return 'IN_PROGRESS';
    }
    return transfer.status === 'READY' || transfer.status === 'DOWNLOADING' ? 'AVAILABLE' : 'INVALID';
  }

  public recordClusterEvent(input: RecordClusterEventInput): ClusterEventRow {
    const id = input.id ?? createFileId();
    const severity = input.severity ?? 'INFO';
    const createdAt = input.createdAt ?? new Date().toISOString();
    const details = typeof input.details === 'object' && input.details !== null
      ? JSON.stringify(input.details)
      : (input.details ?? null);

    this.db.prepare(`
      INSERT INTO cluster_events (id, event_type, severity, node_id, file_id, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.eventType, severity, input.nodeId ?? null, input.fileId ?? null, details, createdAt);

    return {
      id,
      event_type: input.eventType,
      severity,
      node_id: input.nodeId ?? null,
      file_id: input.fileId ?? null,
      details,
      created_at: createdAt,
    };
  }

  public getClusterOverview(): ClusterOverview {
    const nodeStats = this.db.prepare(`
      SELECT
        COUNT(*) AS total_nodes,
        COUNT(CASE WHEN status = 'HEALTHY' THEN 1 END) AS healthy_nodes,
        COUNT(CASE WHEN status = 'UNHEALTHY' THEN 1 END) AS unhealthy_nodes,
        COUNT(CASE WHEN status = 'UNAVAILABLE' THEN 1 END) AS unavailable_nodes,
        COALESCE(SUM(total_capacity_bytes), 0) AS total_capacity_bytes,
        COALESCE(SUM(used_capacity_bytes), 0) AS used_capacity_bytes
      FROM storage_nodes
    `).get() as {
      total_nodes: number;
      healthy_nodes: number;
      unhealthy_nodes: number;
      unavailable_nodes: number;
      total_capacity_bytes: number;
      used_capacity_bytes: number;
    };

    const storedChunkCount = (this.db.prepare(
      "SELECT COUNT(*) FROM chunks WHERE status = 'STORED'"
    ).pluck().get() as number) ?? 0;

    const activeReplicaCount = (this.db.prepare(
      "SELECT COUNT(*) FROM chunk_replicas WHERE status = 'ACTIVE'"
    ).pluck().get() as number) ?? 0;

    const underReplicatedChunkCount = this.getRecoveryCandidates(2).length;

    return {
      totalNodes: Number(nodeStats.total_nodes),
      healthyNodes: Number(nodeStats.healthy_nodes),
      unhealthyNodes: Number(nodeStats.unhealthy_nodes),
      unavailableNodes: Number(nodeStats.unavailable_nodes),
      totalCapacityBytes: Number(nodeStats.total_capacity_bytes),
      usedCapacityBytes: Number(nodeStats.used_capacity_bytes),
      storedChunkCount,
      activeReplicaCount,
      underReplicatedChunkCount,
    };
  }

  public getClusterNodes(now = new Date()): ClusterNodeInfo[] {
    const rows = this.db.prepare(`
      SELECT
        s.node_id,
        s.status,
        s.last_heartbeat,
        s.total_capacity_bytes,
        s.used_capacity_bytes,
        s.active_operations,
        COUNT(DISTINCT CASE WHEN r.status = 'ACTIVE' THEN r.chunk_id END) AS stored_chunk_count,
        COUNT(CASE WHEN r.status = 'ACTIVE' THEN 1 END) AS replica_count
      FROM storage_nodes s
      LEFT JOIN chunk_replicas r ON r.node_id = s.node_id
      GROUP BY s.node_id
      ORDER BY s.node_id
    `).all() as Array<{
      node_id: string;
      status: string;
      last_heartbeat: string;
      total_capacity_bytes: number;
      used_capacity_bytes: number;
      active_operations: number;
      stored_chunk_count: number;
      replica_count: number;
    }>;

    const nowMs = now.getTime();
    return rows.map((r) => {
      const hbTime = new Date(r.last_heartbeat).getTime();
      const ageMs = Number.isFinite(hbTime) ? Math.max(0, nowMs - hbTime) : 999_999_999;
      return {
        nodeId: r.node_id,
        status: r.status,
        lastHeartbeat: r.last_heartbeat,
        lastHeartbeatAgeMs: ageMs,
        totalCapacityBytes: Number(r.total_capacity_bytes),
        usedCapacityBytes: Number(r.used_capacity_bytes),
        activeOperations: Number(r.active_operations),
        storedChunkCount: Number(r.stored_chunk_count),
        replicaCount: Number(r.replica_count),
      };
    });
  }

  public listClusterTransfers(limit = 20): ClusterTransferSummary[] {
    const cappedLimit = Math.min(Math.max(1, limit), 100);
    const rows = this.db.prepare(`
      SELECT
        file_id,
        status,
        chunk_count,
        chunk_size_bytes,
        total_size_bytes,
        download_count,
        max_downloads,
        created_at,
        expires_at
      FROM transfers
      ORDER BY created_at DESC
      LIMIT ?
    `).all(cappedLimit) as Array<{
      file_id: string;
      status: string;
      chunk_count: number;
      chunk_size_bytes: number;
      total_size_bytes: number;
      download_count: number;
      max_downloads: number;
      created_at: string;
      expires_at: string;
    }>;

    if (rows.length === 0) return [];

    const fileIds = rows.map((r) => r.file_id);
    const placeholders = fileIds.map(() => '?').join(',');

    const degradedRows = this.db.prepare(`
      SELECT DISTINCT c.file_id
      FROM chunks c
      LEFT JOIN chunk_replicas r ON r.chunk_id = c.chunk_id AND r.status = 'ACTIVE'
      LEFT JOIN storage_nodes s ON s.node_id = r.node_id AND s.status = 'HEALTHY'
      WHERE c.file_id IN (${placeholders}) AND c.status = 'STORED'
      GROUP BY c.chunk_id
      HAVING COUNT(s.node_id) < 2
    `).pluck().all(...fileIds) as string[];

    const degradedSet = new Set(degradedRows);

    return rows.map((r) => ({
      fileId: r.file_id,
      status: r.status,
      chunkCount: r.chunk_count,
      chunkSizeBytes: r.chunk_size_bytes,
      totalSizeBytes: r.total_size_bytes,
      downloadCount: r.download_count,
      maxDownloads: r.max_downloads,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      isDegraded: degradedSet.has(r.file_id),
    }));
  }

  public getTransferChunks(fileId: string): ClusterTransferDetail | undefined {
    const transfer = this.getTransfer(fileId);
    if (!transfer) return undefined;

    const chunkRows = this.db.prepare(`
      SELECT chunk_id, chunk_index, size_bytes, checksum_sha256, status
      FROM chunks
      WHERE file_id = ?
      ORDER BY chunk_index ASC
    `).all(fileId) as Array<{
      chunk_id: string;
      chunk_index: number;
      size_bytes: number;
      checksum_sha256: string;
      status: string;
    }>;

    const replicaRows = this.db.prepare(`
      SELECT r.chunk_id, r.node_id, r.status AS replica_status, COALESCE(s.status, 'UNKNOWN') AS node_status
      FROM chunk_replicas r
      JOIN chunks c ON c.chunk_id = r.chunk_id
      LEFT JOIN storage_nodes s ON s.node_id = r.node_id
      WHERE c.file_id = ?
      ORDER BY r.chunk_id, r.node_id
    `).all(fileId) as Array<{
      chunk_id: string;
      node_id: string;
      replica_status: string;
      node_status: string;
    }>;

    const replicasByChunk = new Map<string, ClusterChunkReplicaInfo[]>();
    for (const row of replicaRows) {
      const list = replicasByChunk.get(row.chunk_id) ?? [];
      list.push({
        nodeId: row.node_id,
        status: row.replica_status,
        nodeStatus: row.node_status,
      });
      replicasByChunk.set(row.chunk_id, list);
    }

    const chunks: ClusterChunkDetail[] = chunkRows.map((chunk) => {
      const replicas = replicasByChunk.get(chunk.chunk_id) ?? [];
      const activeReplicaCount = replicas.filter(
        (r) => r.status === 'ACTIVE' && r.nodeStatus === 'HEALTHY',
      ).length;
      return {
        chunkId: chunk.chunk_id,
        chunkIndex: chunk.chunk_index,
        sizeBytes: chunk.size_bytes,
        checksumSha256: chunk.checksum_sha256,
        status: chunk.status,
        expectedReplicaCount: 2,
        activeReplicaCount,
        replicas,
      };
    });

    return {
      fileId: transfer.file_id,
      status: transfer.status,
      totalSizeBytes: transfer.total_size_bytes,
      chunkCount: transfer.chunk_count,
      createdAt: transfer.created_at,
      expiresAt: transfer.expires_at,
      chunks,
    };
  }

  public listClusterEvents(options?: {
    limit?: number;
    nodeId?: string;
    eventType?: string;
    afterId?: string;
  }): ClusterEventRow[] {
    const limit = Math.min(Math.max(1, options?.limit ?? 50), 100);
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.afterId) {
      const targetRow = this.db.prepare('SELECT rowid FROM cluster_events WHERE id = ?').get(options.afterId) as { rowid: number } | undefined;
      if (targetRow) {
        conditions.push('rowid > ?');
        params.push(targetRow.rowid);
      }
    }

    if (options?.nodeId) {
      conditions.push('node_id = ?');
      params.push(options.nodeId);
    }
    if (options?.eventType) {
      conditions.push('event_type = ?');
      params.push(options.eventType);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    return this.db.prepare(`
      SELECT id, event_type, severity, node_id, file_id, details, created_at
      FROM cluster_events
      ${where}
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(...params) as ClusterEventRow[];
  }

  public close(): void {
    this.db.close();
  }
}
