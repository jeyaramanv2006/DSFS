import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { HealthMonitor, type HeartbeatInput } from './monitor.js';

interface HeartbeatBody extends HeartbeatInput {}

function isAuthorized(authHeader: string | undefined, expectedSecret: string): boolean {
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  const token = authHeader.slice(7).trim();
  const tokenBuf = Buffer.from(token, 'utf8');
  const secretBuf = Buffer.from(expectedSecret, 'utf8');
  if (tokenBuf.length !== secretBuf.length) {
    return false;
  }
  return timingSafeEqual(tokenBuf, secretBuf);
}

function validHeartbeat(body: Partial<HeartbeatBody>): body is HeartbeatBody {
  const { nodeId, endpointUrl, totalCapacityBytes, usedCapacityBytes, activeOperations } = body;
  return typeof nodeId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(nodeId) &&
    typeof endpointUrl === 'string' && /^https?:\/\/[^\s]+$/.test(endpointUrl) &&
    typeof totalCapacityBytes === 'number' && Number.isSafeInteger(totalCapacityBytes) && totalCapacityBytes >= 0 &&
    typeof usedCapacityBytes === 'number' && Number.isSafeInteger(usedCapacityBytes) && usedCapacityBytes >= 0 &&
    usedCapacityBytes <= totalCapacityBytes &&
    typeof activeOperations === 'number' && Number.isSafeInteger(activeOperations) && activeOperations >= 0;
}

export interface HealthRouteOptions {
  clusterSecret?: string;
  allowedNodeIds?: string[];
}

export function registerHealthRoutes(
  app: FastifyInstance,
  monitor: HealthMonitor,
  options: HealthRouteOptions = {},
): void {
  app.post<{ Body: Partial<HeartbeatBody> }>('/api/nodes/heartbeat', async (request, reply) => {
    if (options.clusterSecret) {
      if (!isAuthorized(request.headers.authorization, options.clusterSecret)) {
        return reply.code(401).send({ error: 'UNAUTHORIZED' });
      }
    }

    const body = request.body ?? {};
    if (!validHeartbeat(body)) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR' });
    }

    if (options.allowedNodeIds && !options.allowedNodeIds.includes(body.nodeId)) {
      return reply.code(403).send({ error: 'NODE_NOT_CONFIGURED' });
    }

    const existingNode = monitor.getStorageNode(body.nodeId);
    if (existingNode && existingNode.endpoint_url !== body.endpointUrl) {
      return reply.code(403).send({ error: 'ENDPOINT_MISMATCH' });
    }

    monitor.recordHeartbeat(body);
    return reply.code(200).send({ acknowledged: true });
  });

  app.get('/api/nodes/health', async (_request, reply) => {
    const transitions = monitor.refresh();
    return reply.code(200).send({ transitions, nodes: monitor.listNodes() });
  });
}
