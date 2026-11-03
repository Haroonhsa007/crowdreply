import { Writable } from 'node:stream';
import { createApp } from '../../src/app.js';
import { registerApiRoutes } from '../../src/api/routes.js';
import { loadConfig } from '../../src/config/index.js';
import { createLogger } from '../../src/logging/index.js';
import { createKeyStore } from '../../src/keys/redis-key-store.js';
import { createKeyResolver } from '../../src/keys/key-resolver.js';
import { FakeRedis } from '../keys/fake-redis.js';
import { repositoryFixture } from '../db/fake-driver.js';
import { foundationEnv } from '../foundation/fixtures.js';

export function apiFixture(
  clock?: () => number,
  overrides: NodeJS.ProcessEnv = {},
) {
  const config = loadConfig({ ...foundationEnv, ...overrides });
  const { repository, storage } = repositoryFixture(
    () => new Date(clock?.() ?? Date.now()),
  );
  const keyStore = createKeyStore(
    new FakeRedis(clock),
    config.KEY_ENCRYPTION_SECRET,
    clock,
  );
  const resolver = createKeyResolver(keyStore, config);
  const jobs = new Map<string, { executionId: string; executionKey: string }>();
  const enqueuer = {
    enqueue: async (payload: { executionId: string; executionKey: string }) => {
      jobs.set(payload.executionKey, payload);
    },
  };
  let logs = '';
  const logger = createLogger(
    config,
    new Writable({
      write(chunk, _encoding, callback) {
        logs += String(chunk);
        callback();
      },
    }),
  );
  const deps = { config, repository, resolver, keyStore, enqueuer, clock };
  const app = createApp({
    logger,
    checks: { mongo: async () => {}, redis: async () => {} },
    registerRoutes: (app) => registerApiRoutes(app, deps),
  });
  return { app, deps, jobs, storage, logger, logs: () => logs };
}
