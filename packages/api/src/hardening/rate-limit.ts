import type { FastifyReply, FastifyRequest } from 'fastify';

export interface RateLimitRule { max: number; windowMs: number }
interface Counter { count: number; resetAt: number }

export class RouteRateLimiter {
  private readonly counters = new Map<string, Counter>();
  private lastPruneAt = 0;
  private readonly pruneIntervalMs: number;

  public constructor(
    private readonly rules: Record<string, RateLimitRule> = {
      init: { max: 20, windowMs: 60_000 },
      upload: { max: 120, windowMs: 60_000 },
      access: { max: 20, windowMs: 60_000 },
      download: { max: 120, windowMs: 60_000 },
    },
    pruneIntervalMs = 10_000,
  ) {
    this.pruneIntervalMs = pruneIntervalMs;
  }

  public get size(): number {
    return this.counters.size;
  }

  public prune(now = Date.now()): number {
    let pruned = 0;
    for (const [key, counter] of this.counters.entries()) {
      if (counter.resetAt <= now) {
        this.counters.delete(key);
        pruned += 1;
      }
    }
    this.lastPruneAt = now;
    return pruned;
  }

  public check(route: string, identity: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    if (now - this.lastPruneAt >= this.pruneIntervalMs || this.counters.size > 500) {
      this.prune(now);
    }

    const rule = this.rules[route];
    if (!rule) return { allowed: true, retryAfterSeconds: 0 };
    const key = `${route}:${identity}`;
    const current = this.counters.get(key);
    if (!current || current.resetAt <= now) {
      this.counters.set(key, { count: 1, resetAt: now + rule.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (current.count < rule.max) {
      current.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }
}

export function rateLimit(limiter: RouteRateLimiter, route: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const result = limiter.check(route, request.ip);
    if (!result.allowed) {
      reply.header('retry-after', String(result.retryAfterSeconds));
      await reply.code(429).send({ error: 'RATE_LIMITED' });
    }
  };
}
