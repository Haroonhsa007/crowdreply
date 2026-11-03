import { describe, expect, it, vi } from 'vitest';
import {
  processExecution,
  type WorkerDependencies,
} from '../../src/workers/provider-worker.js';
import { recoverExecutions } from '../../src/workers/recovery.js';
import { createMongoBudgetGate } from '../../src/workers/live-budget.js';
import {
  createProviderAdapters,
  liveCostEstimate,
} from '../../src/providers/index.js';
import { ProviderError } from '../../src/contracts/index.js';
import { loadConfig } from '../../src/config/index.js';
import { createLogger } from '../../src/logging/index.js';
import { foundationEnv } from '../foundation/fixtures.js';
import { repositoryFixture } from '../db/fake-driver.js';
import { executionInput, syntheticResult } from '../db/fixtures.js';

async function liveFixture() {
  let now = Date.now();
  const config = loadConfig({ ...foundationEnv, LOG_LEVEL: 'silent' });
  const { repository, storage } = repositoryFixture(() => new Date(now));
  const resolver: WorkerDependencies['resolver'] = {
    resolve: async (provider) => ({
      provider,
      mode: 'live',
      keySource: 'env',
      apiKey: 'placeholder-regression-key',
    }),
  };
  const adapters = createProviderAdapters({ config, resolver, fetch: vi.fn() });
  const execute = vi
    .spyOn(adapters.openai, 'executeResolved')
    .mockResolvedValue({ ...syntheticResult, model: config.OPENAI_MODEL });
  const deps: WorkerDependencies = {
    config,
    repository,
    resolver,
    adapters,
    logger: createLogger(config),
    budgetGate: createMongoBudgetGate(storage.spend),
    // Deterministic synthetic adapter: this bound is not used by production.
    liveBudgetBound: () => 0.05,
    pause: vi.fn(),
    schedule: vi.fn(),
    random: () => 0.9,
    clock: () => now,
  };
  const create = async (questionId: string) => {
    const { execution } = await repository.createQueuedIfAbsent({
      ...executionInput,
      questionId,
      model: config.OPENAI_MODEL,
    });
    return {
      execution,
      payload: {
        executionId: execution.id,
        executionKey: execution.executionKey,
      },
    };
  };
  return {
    deps,
    repository,
    storage,
    execute,
    create,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => new Date(now),
    reserve: Math.max(
      config.LIVE_CALL_RESERVE_USD,
      liveCostEstimate('openai', config.OPENAI_MODEL)!,
    ),
  };
}

describe('FIX-02 live spend regressions against the real repository with a fake driver', () => {
  it.each([400, 401, 408, 429, 500, 599])(
    'settles HTTP %s to zero',
    async (httpStatus) => {
      const f = await liveFixture();
      const first = await f.create(`http-${httpStatus}`);
      f.execute.mockRejectedValueOnce(
        new ProviderError({
          category: 'server',
          httpStatus,
          retryable: true,
          message: 'Synthetic HTTP response',
        }),
      );
      await processExecution(first.payload, f.deps);
      expect(await f.repository.getSpendTotal()).toBe(0);
      expect((await f.repository.getById(first.execution.id))?.status).toBe(
        'retry_wait',
      );
    },
  );
  it.each(['abort', 'network'])(
    'reserves a live %s without retrying or pausing',
    async (kind) => {
      const f = await liveFixture();
      const first = await f.create(kind);
      f.execute.mockRejectedValueOnce(
        kind === 'abort'
          ? new DOMException('Synthetic abort', 'AbortError')
          : new TypeError('Synthetic network failure'),
      );
      await processExecution(first.payload, f.deps);
      expect((await f.repository.getById(first.execution.id))?.status).toBe(
        'unknown_outcome',
      );
      expect(await f.repository.getSpendTotal()).toBe(f.reserve);
      expect(f.deps.schedule).not.toHaveBeenCalled();
      expect(f.deps.pause).not.toHaveBeenCalled();
    },
  );
  it('settles successful spend before making the execution terminal', async () => {
    const f = await liveFixture();
    const first = await f.create('completion-crash-window');
    const complete = f.repository.saveRawAndComplete.bind(f.repository);
    vi.spyOn(f.repository, 'saveRawAndComplete').mockImplementation(
      async (...args) => {
        expect(await f.repository.getSpendTotal()).toBe(
          syntheticResult.cost.totalUsd,
        );
        return complete(...args);
      },
    );
    await processExecution(first.payload, f.deps);
    expect((await f.repository.getById(first.execution.id))?.status).toBe(
      'succeeded',
    );
  });
  it('retries live HTTP 503 then succeeds without dying or pausing the provider', async () => {
    const f = await liveFixture();
    const first = await f.create('503-retry');
    f.execute.mockRejectedValueOnce(
      new ProviderError({
        category: 'server',
        httpStatus: 503,
        retryable: true,
        message: 'Synthetic HTTP failure',
      }),
    );
    await processExecution(first.payload, f.deps);
    expect((await f.repository.getById(first.execution.id))?.status).toBe(
      'retry_wait',
    );
    f.advance(1801);
    await processExecution(first.payload, f.deps);
    expect((await f.repository.getById(first.execution.id))?.status).toBe(
      'succeeded',
    );
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.deps.pause).not.toHaveBeenCalled();
    expect(await f.repository.getSpendTotal()).toBe(
      syntheticResult.cost.totalUsd,
    );
  });
  it('reserves a live timeout as unknown_outcome while a different live execution succeeds under the cap', async () => {
    const f = await liveFixture();
    const first = await f.create('timeout-first');
    f.execute.mockRejectedValueOnce(
      new ProviderError({
        category: 'timeout',
        retryable: true,
        message: 'Synthetic no-response timeout',
      }),
    );
    await processExecution(first.payload, f.deps);
    expect((await f.repository.getById(first.execution.id))?.status).toBe(
      'unknown_outcome',
    );
    const second = await f.create('timeout-independent');
    await processExecution(second.payload, f.deps);
    expect((await f.repository.getById(second.execution.id))?.status).toBe(
      'succeeded',
    );
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.deps.schedule).not.toHaveBeenCalled();
    expect(f.deps.pause).not.toHaveBeenCalled();
    expect(await f.repository.getSpendTotal()).toBeCloseTo(
      f.reserve + syntheticResult.cost.totalUsd!,
    );
    expect(await f.repository.getSpendTotal()).toBeLessThan(
      f.deps.config.SPEND_CAP_USD,
    );
  });
  it('settles an expired live crash null row and releases only its gate so other live work proceeds', async () => {
    const f = await liveFixture();
    const first = await f.create('crashed-first');
    await f.repository.claim(first.execution.executionKey, 1);
    expect(
      await f.deps.budgetGate.acquire(first.execution.executionKey),
    ).not.toBeNull();
    await f.repository.recordAttempt(first.execution.id, {
      n: 1,
      integration: 'live',
      startedAt: f.now().toISOString(),
      reservationUsd: f.reserve,
    });
    await f.repository.recordSpend({
      executionId: first.execution.id,
      idempotencyKey: `${first.execution.id}:provider:1`,
      stage: 'provider',
      amountUsd: null,
    });
    f.advance(2);
    await recoverExecutions(f.repository, { enqueue: vi.fn() }, f.now());
    expect((await f.repository.getById(first.execution.id))?.status).toBe(
      'unknown_outcome',
    );
    const second = await f.create('crash-independent');
    await processExecution(second.payload, f.deps);
    expect((await f.repository.getById(second.execution.id))?.status).toBe(
      'succeeded',
    );
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(
      f.storage.spend.rows.find(
        (row) => row.idempotencyKey === `${first.execution.id}:provider:1`,
      )?.amountUsd,
    ).toBe(f.reserve);
    expect(await f.repository.getSpendTotal()).toBeCloseTo(
      f.reserve + syntheticResult.cost.totalUsd!,
    );
  });
});
