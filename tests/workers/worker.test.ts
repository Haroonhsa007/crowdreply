import { describe, expect, it, vi } from 'vitest';
import {
  processExecution,
  type WorkerDependencies,
} from '../../src/workers/provider-worker.js';
import { recoverExecutions } from '../../src/workers/recovery.js';
import { createMongoBudgetGate } from '../../src/workers/live-budget.js';
import { createProviderAdapters } from '../../src/providers/index.js';
import { loadConfig } from '../../src/config/index.js';
import { ProviderError } from '../../src/contracts/index.js';
import { foundationEnv } from '../foundation/fixtures.js';
import { repositoryFixture } from '../db/fake-driver.js';
import { executionInput } from '../db/fixtures.js';
import { createLogger } from '../../src/logging/index.js';

async function fixture(live = false) {
  let now = Date.now();
  const config = loadConfig({ ...foundationEnv, LOG_LEVEL: 'silent' });
  const { repository, storage } = repositoryFixture(() => new Date(now));
  const resolver: WorkerDependencies['resolver'] = {
    resolve: async (provider) =>
      live
        ? {
            provider,
            mode: 'live',
            keySource: 'env',
            apiKey: 'placeholder-live-key',
          }
        : { provider, mode: 'mock', keySource: 'none' },
  };
  const adapters = createProviderAdapters({ config, resolver });
  const { execution } = await repository.createQueuedIfAbsent({
    ...executionInput,
    model: config.OPENAI_MODEL,
  });
  const deps: WorkerDependencies = {
    repository,
    resolver,
    adapters,
    config,
    logger: createLogger(config),
    budgetGate: createMongoBudgetGate(storage.spend),
    // Deterministic synthetic adapter: this bound is not used by production.
    liveBudgetBound: () => 0.05,
    schedule: vi.fn(),
    pause: vi.fn(),
    clock: () => now,
    random: () => 0.9,
  };
  return {
    deps,
    storage,
    execution,
    payload: {
      executionId: execution.id,
      executionKey: execution.executionKey,
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe('provider worker safety and recovery', () => {
  it('completes a mock with raw data and ignores duplicate jobs', async () => {
    const f = await fixture();
    const call = vi.spyOn(f.deps.adapters.openai, 'executeResolved');
    await processExecution(f.payload, f.deps);
    await processExecution(f.payload, f.deps);
    expect(call).toHaveBeenCalledTimes(1);
    expect(f.storage.raw.rows).toHaveLength(1);
    expect((await f.deps.repository.getById(f.execution.id))?.status).toBe(
      'succeeded',
    );
    expect(await f.deps.repository.getSpendTotal()).toBe(0);
  });
  it('retries transient mock failures with increasing backoff then succeeds', async () => {
    const f = await fixture();
    const original = f.deps.adapters.openai.executeResolved;
    vi.spyOn(f.deps.adapters.openai, 'executeResolved')
      .mockRejectedValueOnce(
        new ProviderError({
          category: 'server',
          retryable: true,
          message: 'Synthetic failure',
        }),
      )
      .mockRejectedValueOnce(
        new ProviderError({
          category: 'server',
          retryable: true,
          message: 'Synthetic failure',
        }),
      )
      .mockImplementation(original);
    await processExecution(f.payload, f.deps);
    expect(f.deps.schedule).toHaveBeenLastCalledWith(f.payload, 1800);
    f.advance(1801);
    await processExecution(f.payload, f.deps);
    expect(f.deps.schedule).toHaveBeenLastCalledWith(f.payload, 3600);
    f.advance(3601);
    await processExecution(f.payload, f.deps);
    expect(f.storage.raw.rows).toHaveLength(1);
    expect(
      (await f.deps.repository.getById(f.execution.id))?.attempts,
    ).toHaveLength(3);
  });
  it('permanent failures and exhausted retries go dead', async () => {
    for (const permanent of [true, false]) {
      const f = await fixture();
      f.deps.config.MAX_ATTEMPTS = 1;
      vi.spyOn(f.deps.adapters.openai, 'executeResolved').mockRejectedValue(
        new ProviderError({
          category: permanent ? 'auth' : 'server',
          retryable: !permanent,
          message: 'Synthetic failure',
        }),
      );
      await processExecution(f.payload, f.deps);
      expect((await f.deps.repository.getById(f.execution.id))?.status).toBe(
        'dead',
      );
    }
  });
  it('refuses unknown or insufficient live budgets before any provider call', async () => {
    for (const total of [null, 1.99]) {
      const f = await fixture(true);
      vi.spyOn(f.deps.repository, 'getSpendTotal').mockResolvedValue(total);
      const execute = vi.spyOn(f.deps.adapters.openai, 'executeResolved');
      await processExecution(f.payload, f.deps);
      expect(execute).not.toHaveBeenCalled();
      expect((await f.deps.repository.getById(f.execution.id))?.status).toBe(
        'dead',
      );
      expect(f.deps.pause).toHaveBeenCalledWith('openai');
    }
  });
  it('never repeats a crashed live attempt, while a crashed mock can recover', async () => {
    for (const live of [true, false]) {
      const f = await fixture(live);
      await f.deps.repository.claim(f.execution.executionKey, 1);
      await f.deps.repository.recordAttempt(f.execution.id, {
        n: 1,
        integration: live ? 'live' : 'mock',
        startedAt: new Date().toISOString(),
      });
      f.advance(2);
      const execute = vi.spyOn(f.deps.adapters.openai, 'executeResolved');
      await processExecution(f.payload, f.deps);
      expect((await f.deps.repository.getById(f.execution.id))?.status).toBe(
        live ? 'unknown_outcome' : 'succeeded',
      );
      expect(execute).toHaveBeenCalledTimes(live ? 0 : 1);
    }
  });
  it('heals a lost queue from Mongo references and excludes terminal work', async () => {
    const f = await fixture();
    const enqueue = vi.fn();
    expect(await recoverExecutions(f.deps.repository, { enqueue })).toBe(1);
    expect(enqueue).toHaveBeenCalledWith(f.payload);
    await processExecution(f.payload, f.deps);
    expect(await recoverExecutions(f.deps.repository, { enqueue })).toBe(0);
  });
  it('serializes global live calls and never steals a held Mongo budget gate', async () => {
    const f = await fixture();
    const gate = createMongoBudgetGate(f.storage.spend);
    const release = await gate.acquire('one');
    expect(release).not.toBeNull();
    expect(await gate.acquire('two')).toBeNull();
    await release!();
    expect(await gate.acquire('two')).not.toBeNull();
  });
});
