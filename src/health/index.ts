import type { Express } from 'express';
import { MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';

export type DependencyCheck = (signal: AbortSignal) => Promise<void>;
export interface DependencyChecks { mongo: DependencyCheck; redis: DependencyCheck; }

class HealthTimeoutError extends Error {}

async function inspect(check: DependencyCheck): Promise<{ status: 'up' } | { status: 'down'; reason: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => check(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new HealthTimeoutError()); }, 1000);
      }),
    ]);
    return { status: 'up' };
  } catch (error) {
    return { status: 'down', reason: error instanceof HealthTimeoutError ? 'Health check timed out' : 'Dependency unavailable' };
  } finally { if (timer) clearTimeout(timer); }
}

/** The only real dependency access in foundation: lazy, bounded readiness pings. */
export function createDependencyChecks(config: Config, logger: Logger): { checks: DependencyChecks; close: () => Promise<void> } {
  const mongo = new MongoClient(config.MONGODB_URI, {
    serverSelectionTimeoutMS: 1000, connectTimeoutMS: 1000, socketTimeoutMS: 1000, maxPoolSize: 1,
  });
  const redis = new Redis(config.REDIS_URL, {
    lazyConnect: true, enableOfflineQueue: false, connectTimeout: 1000, commandTimeout: 1000,
    maxRetriesPerRequest: 0, retryStrategy: () => null,
  });
  redis.on('error', () => logger.warn({ event: 'dependency.error', dependency: 'redis' }, 'Redis health connection failed'));
  let redisConnection: Promise<void> | undefined;
  return {
    checks: {
      mongo: async signal => {
        signal.throwIfAborted();
        await mongo.db().command({ ping: 1 }, { timeoutMS: 1000 });
      },
      redis: async signal => {
        signal.throwIfAborted();
        if (redis.status !== 'ready') {
          if (!redisConnection) redisConnection = redis.connect().finally(() => { redisConnection = undefined; });
          await redisConnection;
        }
        signal.throwIfAborted();
        await redis.ping();
      },
    },
    close: async () => { redis.disconnect(); await mongo.close(); },
  };
}

export function registerHealthRoutes(app: Express, checks: DependencyChecks): void {
  app.get('/health', (_req, res) => { res.status(200).json({ status: 'ok' }); });
  app.get('/health/ready', async (_req, res) => {
    const [mongo, redis] = await Promise.all([inspect(checks.mongo), inspect(checks.redis)]);
    const ready = mongo.status === 'up' && redis.status === 'up';
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', dependencies: { mongo, redis } });
  });
}
