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

  it('prunes expired rate limiter entries and prevents unbounded memory growth', () => {
    const limiter = new RouteRateLimiter({ init: { max: 5, windowMs: 1_000 } }, 500);
    const now = 100_000;

    limiter.check('init', '192.168.1.1', now);
    limiter.check('init', '192.168.1.2', now);
    expect(limiter.size).toBe(2);

    // After 1001ms, window has expired
    const pruned = limiter.prune(now + 1_001);
    expect(pruned).toBe(2);
    expect(limiter.size).toBe(0);

    // Automatic pruning during check()
    limiter.check('init', '192.168.1.3', now);
    expect(limiter.size).toBe(1);
    limiter.check('init', '192.168.1.4', now + 2_000); // Triggers auto-prune
    expect(limiter.size).toBe(1); // 1.3 pruned, only 1.4 present
  });

  it('rejects transfer initialization with non-positive maxDownloads', async () => {
    const database = new MetadataDatabase();
    const app = buildApiServer(database, undefined, undefined, undefined, undefined, { logger: false });

    const zeroDownloadsPayload = {
      authToken: 'ab'.repeat(32),
      totalSizeBytes: 1,
      chunkCount: 1,
      ttlSeconds: 600,
      maxDownloads: 0,
    };
    const zeroRes = await app.inject({ method: 'POST', url: '/api/transfers', payload: zeroDownloadsPayload });
    expect(zeroRes.statusCode).toBe(400);
    expect(zeroRes.json()).toEqual({ error: 'VALIDATION_ERROR' });

    const negativePayload = { ...zeroDownloadsPayload, maxDownloads: -5 };
    const negRes = await app.inject({ method: 'POST', url: '/api/transfers', payload: negativePayload });
    expect(negRes.statusCode).toBe(400);
    expect(negRes.json()).toEqual({ error: 'VALIDATION_ERROR' });

    await app.close();
    database.close();
  });
});

