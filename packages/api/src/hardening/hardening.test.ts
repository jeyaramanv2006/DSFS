import { describe, expect, it } from 'vitest';
import { MetadataDatabase } from '../db/database.js';
import { buildApiServer } from '../server.js';
import { createLoggerOptions, REDACTED_LOG_PATHS } from './logging.js';
import { RouteRateLimiter } from './rate-limit.js';

describe('API hardening controls', () => {
  it('enforces route-specific limits with a retry-after response', async () => {
    const database = new MetadataDatabase();
    const app = buildApiServer(database, undefined, undefined, undefined, undefined, {
      logger: false,
      rateLimiter: new RouteRateLimiter({ init: { max: 1, windowMs: 60_000 } }),
    });
    const payload = { authToken: 'ab'.repeat(32), totalSizeBytes: 1, chunkCount: 1, ttlSeconds: 600 };
    expect((await app.inject({ method: 'POST', url: '/api/transfers', payload })).statusCode).toBe(201);
    const limited = await app.inject({ method: 'POST', url: '/api/transfers', payload });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.json()).toEqual({ error: 'RATE_LIMITED' });
    await app.close();
    database.close();
  });

  it('configures Pino redaction for every credential-bearing field', () => {
    const options = createLoggerOptions();
    expect(options.redact.remove).toBe(true);
    expect(REDACTED_LOG_PATHS).toEqual(expect.arrayContaining([
      'req.headers.authorization',
      'req.body.authToken',
      'req.body.uploadToken',
      'req.body.downloadToken',
      'res.body.uploadToken',
      'res.body.downloadToken',
    ]));
    expect(JSON.stringify(options)).not.toContain('0001020304050607');
  });
});
