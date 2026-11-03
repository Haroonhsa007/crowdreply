import { pathToFileURL } from 'node:url';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { ConfigError, loadConfig, redactedConfig } from './config/index.js';
import { createLogger } from './logging/index.js';
import { createApp } from './app.js';
import { createDatabase } from './db/connection.js';
import {
  createExecutionRepository,
  mongoStorage,
} from './db/execution-repository.js';
import { createKeyStore } from './keys/redis-key-store.js';
import { createKeyResolver } from './keys/key-resolver.js';
import { createQueues } from './queue/queues.js';
import { createProviderAdapters } from './providers/index.js';
import { createMongoBudgetGate } from './workers/live-budget.js';
import { registerApiRoutes } from './api/routes.js';
import {
  createExtractionRepository,
  mongoExtractionStorage,
} from './db/extraction-repository.js';
import { createExtractionQueue } from './queue/extraction-queue.js';
import { createExtractionService } from './extraction/service.js';

export function bindHost(configured: string): string {
  // Only the image sets this flag; host-run services remain loopback-only.
  return z.enum(['0', '1']).default('0').parse(process.env.CONTAINERIZED) ===
    '1'
    ? '0.0.0.0'
    : configured;
}
export async function createRuntime() {
  const config = loadConfig();
  const logger = createLogger(config);
  const database = createDatabase(config);
  const redis = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 1000,
    commandTimeout: 2000,
    maxRetriesPerRequest: 0,
    // Commands fail within their bounded deadline, while the client reconnects
    // after a transient Redis restart instead of remaining permanently closed.
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 2000),
  });
  const transport = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: true,
    maxRetriesPerRequest: null,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 2000),
  });
  redis.on('error', () =>
    logger.error({ stage: 'redis.error' }, 'Redis connection failed'),
  );
  transport.on('error', () =>
    logger.error(
      { stage: 'queue.connection_error' },
      'Queue connection failed',
    ),
  );
  const extractions = createExtractionRepository(
    mongoExtractionStorage(database.getDb()),
  );
  try {
    await database.ensureIndexes();
    await extractions.seedAliases();
    await redis.connect();
  } catch {
    redis.disconnect();
    transport.disconnect();
    await database.close();
    throw new Error('Runtime dependencies unavailable');
  }
  const repository = createExecutionRepository(mongoStorage(database.getDb()));
  const keyStore = createKeyStore(redis, config.KEY_ENCRYPTION_SECRET);
  const resolver = createKeyResolver(keyStore, config);
  // Producers fail commands quickly; only Worker transport may queue offline.
  const queue = createQueues(redis, repository);
  const extractionQueue = createExtractionQueue(redis, extractions);
  const extractionService = createExtractionService({
    repository,
    extractions,
    enqueuer: extractionQueue.enqueuer,
    logger,
  });
  const adapters = createProviderAdapters({ resolver, config });
  const budgetGate = createMongoBudgetGate(
    mongoStorage(database.getDb()).spend,
  );
  const checks = {
    mongo: async () => {
      await database.getDb().command({ ping: 1 }, { timeoutMS: 1000 });
    },
    redis: async () => {
      await redis.ping();
    },
  };
  return {
    config,
    logger,
    repository,
    extractions,
    extractionQueue,
    extractionService,
    keyStore,
    resolver,
    queue,
    adapters,
    budgetGate,
    checks,
    transport,
    async close() {
      await Promise.all([queue.close(), extractionQueue.close()]);
      redis.disconnect();
      transport.disconnect();
      await database.close();
    },
  };
}
export function handleShutdown(
  stop: () => Promise<void>,
  logger: ReturnType<typeof createLogger>,
  deadlineMs = 250000,
): void {
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => {
      logger.error(
        { stage: 'shutdown.timeout' },
        'Graceful shutdown timed out',
      );
      process.exit(1);
    }, deadlineMs).unref();
    try {
      await stop();
      logger.info({ stage: 'shutdown.complete' }, 'Shutdown complete');
      process.exitCode = 0;
    } catch {
      logger.error({ stage: 'shutdown.failed' }, 'Shutdown failed');
      process.exitCode = 1;
    } finally {
      clearTimeout(timeout);
    }
  };
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
}
async function main(): Promise<void> {
  const runtime = await createRuntime();
  const app = createApp({
    logger: runtime.logger,
    checks: runtime.checks,
    registerRoutes: (app) =>
      registerApiRoutes(app, {
        config: runtime.config,
        repository: runtime.repository,
        keyStore: runtime.keyStore,
        resolver: runtime.resolver,
        enqueuer: runtime.queue.enqueuer,
        extractions: runtime.extractions,
        extractionService: runtime.extractionService,
      }),
  });
  const server = app.listen(
    runtime.config.PORT,
    bindHost(runtime.config.HOST),
    () =>
      runtime.logger.info(
        { event: 'server.started', config: redactedConfig(runtime.config) },
        'API listening',
      ),
  );
  handleShutdown(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.close();
  }, runtime.logger);
  server.once('error', () => {
    runtime.logger.error(
      { stage: 'server.listen_failed' },
      'API could not listen',
    );
    void runtime.close().finally(() => {
      process.exitCode = 1;
    });
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      error instanceof ConfigError
        ? error.message + '\n'
        : 'API startup failed; check configuration and dependencies.\n',
    );
    process.exitCode = 1;
  });
}
