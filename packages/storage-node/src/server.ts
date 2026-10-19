import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { FilesystemChunkStore, type IStorageNode } from './storage.js';

interface ChunkParams {
  chunkId: string;
}

function isClientError(error: unknown): boolean {
  return error instanceof Error && (
    error.message === 'invalid chunk ID' ||
    error.message === 'invalid SHA-256 checksum' ||
    error.message === 'checksum mismatch'
  );
}

async function sendNotFound(reply: FastifyReply): Promise<void> {
  await reply.code(404).send({ error: 'CHUNK_NOT_FOUND' });
}

export interface StorageServerOptions {
  clusterSecret?: string;
}

export function buildServer(store: IStorageNode, options: StorageServerOptions = {}): FastifyInstance {
  const app = Fastify({
    bodyLimit: 220 * 1024 * 1024,
    exposeHeadRoutes: false,
    logger: false,
  });

  app.addContentTypeParser(
    'application/octet-stream',
    (_request, payload, done) => done(null, payload),
  );

  app.put<{ Params: ChunkParams }>('/chunks/:chunkId', async (request, reply) => {
    const checksum = request.headers['x-checksum'];
    if (typeof checksum !== 'string') {
      return reply.code(400).send({ error: 'CHECKSUM_REQUIRED' });
    }

    try {
      const result = await store.putChunk(
        request.params.chunkId,
        request.body as NodeJS.ReadableStream,
        checksum,
      );
      return reply.code(200).send({
        chunkId: request.params.chunkId,
        storedSizeBytes: result.sizeBytes,
        checksumVerified: true,
      });
    } catch (error) {
      if (isClientError(error)) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : 'INVALID_CHUNK' });
      }
      throw error;
    }
  });

  app.get<{ Params: ChunkParams }>('/chunks/:chunkId', async (request, reply) => {
    try {
      const stream = await store.getChunk(request.params.chunkId);
      return reply.type('application/octet-stream').send(stream);
    } catch {
      return sendNotFound(reply);
    }
  });

  app.head<{ Params: ChunkParams }>('/chunks/:chunkId', async (request, reply) => {
    try {
      if (!await store.hasChunk(request.params.chunkId)) {
        return sendNotFound(reply);
      }
      return reply.code(200).send();
    } catch (error) {
      if (isClientError(error)) {
        return reply.code(400).send({ error: 'INVALID_CHUNK' });
      }
      throw error;
    }
  });

  app.delete<{ Params: ChunkParams }>('/chunks/:chunkId', async (request, reply) => {
    try {
      const deleted = await store.deleteChunk(request.params.chunkId);
      return reply.code(200).send({ deleted });
    } catch (error) {
      if (isClientError(error)) {
        return reply.code(400).send({ error: 'INVALID_CHUNK' });
      }
      throw error;
    }
  });

  app.get('/chunks', async (_request, reply) => {
    return reply.code(200).send({ chunks: await store.listChunks() });
  });

  app.get('/health', async (_request, reply) => {
    const report = await store.healthCheck();
    return reply.code(200).send(report);
  });

  return app;
}

const nodeId = process.env.NODE_ID ?? 'node-1';
const port = Number(process.env.PORT ?? 9001);
const host = process.env.HOST ?? '0.0.0.0';
const dataDir = process.env.DATA_DIR ?? `./data/${nodeId}`;
const clusterSecret = process.env.STORAGE_CLUSTER_SECRET;

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const app = buildServer(
    new FilesystemChunkStore(
      dataDir,
      nodeId,
      Number(process.env.TOTAL_CAPACITY_BYTES ?? 0),
    ),
    { clusterSecret },
  );
  app.listen({ host, port }).catch((error) => {
    app.log.error(error);
    process.exitCode = 1;
  });
}
