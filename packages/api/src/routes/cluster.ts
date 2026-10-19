import type { FastifyInstance } from 'fastify';
import type { MetadataDatabase } from '../db/database.js';
import type { HealthMonitor } from '../health/monitor.js';

interface ClusterTransfersQuery {
  limit?: string;
}

interface TransferChunksParams {
  fileId: string;
}

interface ClusterEventsQuery {
  limit?: string;
  afterId?: string;
  nodeId?: string;
  eventType?: string;
}

function parseDetails(details: string | null): unknown {
  if (!details) return null;
  try {
    return JSON.parse(details);
  } catch {
    return details;
  }
}

export function registerClusterRoutes(
  app: FastifyInstance,
  database: MetadataDatabase,
  healthMonitor?: HealthMonitor,
): void {
  app.get('/api/cluster/overview', async (_request, reply) => {
    healthMonitor?.refresh();
    const overview = database.getClusterOverview();
    return reply.code(200).send(overview);
  });

  app.get('/api/cluster/nodes', async (_request, reply) => {
    healthMonitor?.refresh();
    const nodes = database.getClusterNodes();
    return reply.code(200).send({ nodes });
  });

  app.get<{ Querystring: ClusterTransfersQuery }>(
    '/api/cluster/transfers',
    async (request, reply) => {
      const parsedLimit = request.query.limit ? Number.parseInt(request.query.limit, 10) : 20;
      const limit = Number.isSafeInteger(parsedLimit) ? parsedLimit : 20;
      const transfers = database.listClusterTransfers(limit);
      return reply.code(200).send({ transfers });
    },
  );

  app.get<{ Params: TransferChunksParams }>(
    '/api/cluster/transfers/:fileId/chunks',
    async (request, reply) => {
      const detail = database.getTransferChunks(request.params.fileId);
      if (!detail) {
        return reply.code(404).send({ error: 'TRANSFER_NOT_FOUND' });
      }
      return reply.code(200).send(detail);
    },
  );

  app.get<{ Querystring: ClusterEventsQuery }>(
    '/api/cluster/events',
    async (request, reply) => {
      const parsedLimit = request.query.limit ? Number.parseInt(request.query.limit, 10) : 50;
      const limit = Number.isSafeInteger(parsedLimit) ? parsedLimit : 50;
      const rawEvents = database.listClusterEvents({
        limit,
        afterId: typeof request.query.afterId === 'string' && request.query.afterId.trim().length > 0
          ? request.query.afterId.trim()
          : undefined,
        nodeId: typeof request.query.nodeId === 'string' && request.query.nodeId.trim().length > 0
          ? request.query.nodeId.trim()
          : undefined,
        eventType: typeof request.query.eventType === 'string' && request.query.eventType.trim().length > 0
          ? request.query.eventType.trim()
          : undefined,
      });

      const events = rawEvents.map((event) => ({
        id: event.id,
        eventType: event.event_type,
        severity: event.severity,
        nodeId: event.node_id,
        fileId: event.file_id,
        details: parseDetails(event.details),
        createdAt: event.created_at,
      }));

      return reply.code(200).send({ events });
    },
  );
}
