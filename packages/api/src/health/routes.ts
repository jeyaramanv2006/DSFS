import type { FastifyInstance } from 'fastify';
import { HealthMonitor, type HeartbeatInput } from './monitor.js';

interface HeartbeatBody extends HeartbeatInput {}

function validHeartbeat(body: Partial<HeartbeatBody>): body is HeartbeatBody {
  const { nodeId, endpointUrl, totalCapacityBytes, usedCapacityBytes, activeOperations } = body;
  return typeof nodeId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(nodeId) &&
    typeof endpointUrl === 'string' && /^https?:\/\/[^\s]+$/.test(endpointUrl) &&
    typeof totalCapacityBytes === 'number' && Number.isSafeInteger(totalCapacityBytes) && totalCapacityBytes >= 0 &&
    typeof usedCapacityBytes === 'number' && Number.isSafeInteger(usedCapacityBytes) && usedCapacityBytes >= 0 &&
    usedCapacityBytes <= totalCapacityBytes &&
    typeof activeOperations === 'number' && Number.isSafeInteger(activeOperations) && activeOperations >= 0;
}

export function registerHealthRoutes(app: FastifyInstance, monitor: HealthMonitor): void {
  app.post<{ Body: Partial<HeartbeatBody> }>('/api/nodes/heartbeat', async (request, reply) => {
    const body = request.body ?? {};
    if (!validHeartbeat(body)) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR' });
    }
    monitor.recordHeartbeat(body);
    return reply.code(200).send({ acknowledged: true });
  });

  app.get('/api/nodes/health', async (_request, reply) => {
    const transitions = monitor.refresh();
    return reply.code(200).send({ transitions, nodes: monitor.listNodes() });
  });
}
