import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { MetadataDatabase } from '../db/database.js';
import type { StorageNodeClient } from '../services/storage-client.js';
import { hashToken, isTokenHex } from '../services/tokens.js';
import type { ChunkReplicator } from '../replication/replication.js';
import { NodeUnavailableError, type ReplicaReadService } from '../replication/read-service.js';
import { RouteRateLimiter, rateLimit } from '../hardening/rate-limit.js';

const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024;
const DEFAULT_CHUNK_SIZE_BYTES = 4 * 1024 * 1024;
const MAX_TTL_SECONDS = 48 * 3600; // 48 Hours maximum
const ALLOWED_TTLS = new Set([600, 3600, 21600, 43200, 86400, 172800]);

interface InitBody {
  authToken: string;
  totalSizeBytes: number;
  chunkCount: number;
  chunkSizeBytes?: number;
  encryptedFileName?: string | null;
  ttlSeconds: number;
  maxDownloads?: number;
}

interface ChunkParams {
  fileId: string;
  index: string;
}

interface FinalizeParams {
  fileId: string;
}

interface FinalizeBody {
  totalChunksUploaded?: number;
}

interface StatusParams {
  fileId: string;
}

interface AccessParams { fileId: string; }
interface DownloadChunkParams { fileId: string; index: string; }

function bearerToken(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) {
    return undefined;
  }
  const token = value.slice('Bearer '.length);
  return isTokenHex(token) ? token : undefined;
}

function tokensEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validateInitBody(body: Partial<InitBody>): asserts body is InitBody {
  const chunkSizeBytes = body.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
  const expectedChunkCount = isPositiveInteger(body.totalSizeBytes) && isPositiveInteger(chunkSizeBytes)
    ? Math.ceil(body.totalSizeBytes / chunkSizeBytes)
    : 0;
  if (
    !isTokenHex(body.authToken) ||
    !isPositiveInteger(body.totalSizeBytes) ||
    body.totalSizeBytes > MAX_FILE_SIZE_BYTES ||
    !isPositiveInteger(body.chunkCount) ||
    body.chunkCount !== expectedChunkCount ||
    !isPositiveInteger(chunkSizeBytes) ||
    chunkSizeBytes > 10 * 1024 * 1024 ||
    !ALLOWED_TTLS.has(body.ttlSeconds!) ||
    (body.maxDownloads !== undefined &&
      (!Number.isSafeInteger(body.maxDownloads) || body.maxDownloads <= 0)) ||
    (body.encryptedFileName !== undefined &&
      body.encryptedFileName !== null &&
      typeof body.encryptedFileName !== 'string')
  ) {
    throw new Error('invalid transfer initialization');
  }
}

export function registerTransferRoutes(
  app: FastifyInstance,
  database: MetadataDatabase,
  storageClient: StorageNodeClient,
  replicator?: ChunkReplicator,
  readService?: Pick<ReplicaReadService, 'getChunk'>,
  limiter = new RouteRateLimiter(),
): void {
  app.post<{ Body: Partial<InitBody> }>('/api/transfers', { preHandler: rateLimit(limiter, 'init') }, async (request, reply) => {
    try {
      validateInitBody(request.body ?? {});
      const chunkSizeBytes = request.body.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
      const chunkCount = request.body.chunkCount!;
      const transfer = database.createTransfer({
        authToken: request.body.authToken!,
        totalSizeBytes: request.body.totalSizeBytes!,
        chunkCount,
        chunkSizeBytes,
        encryptedFileName: request.body.encryptedFileName ?? null,
        ttlSeconds: request.body.ttlSeconds!,
        maxDownloads: request.body.maxDownloads ?? 1,
      });
      return reply.code(201).send({
        fileId: transfer.fileId,
        status: transfer.status,
        expiresAt: transfer.expiresAt,
        uploadToken: transfer.uploadToken,
        chunkUploads: Array.from({ length: chunkCount }, (_, chunkIndex) => ({
          chunkIndex,
          uploadUrl: `/api/transfers/${transfer.fileId}/chunks/${chunkIndex}`,
        })),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid transfer initialization') {
        return reply.code(400).send({ error: 'VALIDATION_ERROR' });
      }
      throw error;
    }
  });

  app.put<{ Params: ChunkParams }>('/api/transfers/:fileId/chunks/:index', { preHandler: rateLimit(limiter, 'upload') }, async (request, reply) => {
    const transfer = database.getTransfer(request.params.fileId);
    const token = bearerToken(request.headers.authorization);
    const providedHash = token ? hashToken(token) : undefined;
    if (!transfer || !providedHash || !tokensEqual(providedHash, transfer.upload_session_hash)) {
      return reply.code(404).send({ error: 'TRANSFER_NOT_FOUND' });
    }

    const chunkIndex = Number(request.params.index);
    const checksum = request.headers['x-chunk-checksum-sha256'];
    if (
      !Number.isSafeInteger(chunkIndex) ||
      chunkIndex < 0 ||
      chunkIndex >= transfer.chunk_count ||
      typeof checksum !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(checksum)
    ) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR' });
    }

    const chunkId = `${request.params.fileId}-${chunkIndex}`;
    let storedSizeBytes: number;
    let replicationAcknowledged = 1;
    if (replicator) {
      const parts: Buffer[] = [];
      for await (const part of request.body as AsyncIterable<Buffer | string>) {
        parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
      }
      const payload = Buffer.concat(parts);
      database.recordPendingChunk(request.params.fileId, chunkIndex, { sizeBytes: payload.length, checksumSha256: checksum });
      const result = await replicator.replicateChunk(chunkId, payload, checksum, 2);
      storedSizeBytes = payload.length;
      replicationAcknowledged = result.confirmedNodeIds.length;
      database.markStoredChunk(request.params.fileId, chunkIndex, { sizeBytes: storedSizeBytes, checksumSha256: checksum });
    } else {
      const result = await storageClient.putChunk(chunkId, request.body as NodeJS.ReadableStream, checksum);
      storedSizeBytes = result.sizeBytes;
      database.recordStoredChunk(request.params.fileId, chunkIndex, result);
    }
    return reply.code(200).send({
      chunkIndex,
      storedSizeBytes,
      checksumVerified: true,
      replicationAcknowledged,
    });
  });

  app.post<{ Params: FinalizeParams; Body: FinalizeBody }>(
    '/api/transfers/:fileId/finalize',
    { preHandler: rateLimit(limiter, 'upload') },
    async (request, reply) => {
      const transfer = database.getTransfer(request.params.fileId);
      const token = bearerToken(request.headers.authorization);
      const providedHash = token ? hashToken(token) : undefined;
      if (!transfer || !providedHash || !tokensEqual(providedHash, transfer.upload_session_hash)) {
        return reply.code(404).send({ error: 'TRANSFER_NOT_FOUND' });
      }

      const uploadedCount = request.body?.totalChunksUploaded;
      if (uploadedCount !== undefined && uploadedCount !== database.countStoredChunks(request.params.fileId)) {
        return reply.code(400).send({ error: 'VALIDATION_ERROR' });
      }
      const finalized = database.finalizeTransfer(request.params.fileId);
      if (!finalized) {
        return reply.code(409).send({ error: 'UPLOAD_INCOMPLETE' });
      }
      return reply.code(200).send({
        fileId: finalized.file_id,
        status: finalized.status,
        expiresAt: finalized.expires_at,
      });
    },
  );

  app.get<{ Params: StatusParams }>('/api/transfers/:fileId/status', { preHandler: rateLimit(limiter, 'upload') }, async (request, reply) => {
    const transfer = database.getTransfer(request.params.fileId);
    const token = bearerToken(request.headers.authorization);
    const providedHash = token ? hashToken(token) : undefined;
    if (!transfer || !providedHash || !tokensEqual(providedHash, transfer.upload_session_hash)) {
      return reply.code(404).send({ error: 'TRANSFER_NOT_FOUND' });
    }

    const uploadedChunkIndices = database.getStoredChunkIndices(request.params.fileId);
    const uploaded = new Set(uploadedChunkIndices);
    const missingChunkIndices = Array.from(
      { length: transfer.chunk_count },
      (_, index) => index,
    ).filter((index) => !uploaded.has(index));
    return reply.code(200).send({
      fileId: transfer.file_id,
      status: transfer.status,
      chunkCount: transfer.chunk_count,
      uploadedChunkIndices,
      missingChunkIndices,
      expiresAt: transfer.expires_at,
    });
  });

  app.post<{ Params: AccessParams }>('/api/transfers/:fileId/access', { preHandler: rateLimit(limiter, 'access') }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const inspection = token
      ? database.inspectAccess(request.params.fileId, hashToken(token))
      : 'INVALID';
    if (inspection === 'GONE') return reply.code(410).send({ error: 'TRANSFER_GONE' });
    if (inspection === 'IN_PROGRESS') return reply.code(409).send({ error: 'DOWNLOAD_IN_PROGRESS' });
    const lease = token && inspection === 'AVAILABLE'
      ? database.acquireDownloadLease(request.params.fileId, hashToken(token))
      : undefined;
    if (!lease) {
      return reply.code(404).send({ error: 'TRANSFER_NOT_FOUND' });
    }
    return reply.code(200).send({
      fileId: lease.transfer.file_id,
      status: lease.transfer.status,
      downloadToken: lease.downloadToken,
      downloadTokenExpiresAt: lease.downloadTokenExpiresAt,
      encryptedFileName: lease.transfer.original_name_encrypted,
      manifest: database.getStoredChunks(request.params.fileId).map((chunk) => ({
        chunkIndex: chunk.chunk_index,
        sizeBytes: chunk.size_bytes,
        checksumSha256: chunk.checksum_sha256,
      })),
    });
  });

  app.get<{ Params: DownloadChunkParams }>(
    '/api/transfers/:fileId/chunks/:index',
    { preHandler: rateLimit(limiter, 'download') },
    async (request, reply) => {
      const transfer = database.getTransfer(request.params.fileId);
      const token = bearerToken(request.headers.authorization);
      const providedHash = token ? hashToken(token) : undefined;
      if (!transfer || !providedHash || !transfer.download_token_hash ||
        !tokensEqual(providedHash, transfer.download_token_hash) ||
        transfer.status !== 'DOWNLOADING' ||
        !transfer.download_lease_until || transfer.download_lease_until <= new Date().toISOString()) {
        return reply.code(404).send({ error: 'TRANSFER_NOT_FOUND' });
      }
      const chunkIndex = Number(request.params.index);
      if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= transfer.chunk_count) {
        return reply.code(404).send({ error: 'TRANSFER_NOT_FOUND' });
      }
      try {
        const stream = await (readService ?? storageClient).getChunk(`${request.params.fileId}-${chunkIndex}`);
        return reply.type('application/octet-stream').send(stream);
      } catch (error) {
        if (error instanceof NodeUnavailableError) {
          return reply.code(503).send({ error: error.code });
        }
        return reply.code(502).send({ error: 'CHUNK_UNAVAILABLE' });
      }
    },
  );

  app.post<{ Params: AccessParams }>('/api/transfers/:fileId/complete', { preHandler: rateLimit(limiter, 'download') }, async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const completed = token
      ? database.completeDownload(request.params.fileId, hashToken(token))
      : undefined;
    if (!completed) {
      return reply.code(404).send({ error: 'TRANSFER_NOT_FOUND' });
    }
    return reply.code(200).send({
      fileId: completed.file_id,
      status: completed.status,
      downloadCount: completed.download_count,
    });
  });
}
