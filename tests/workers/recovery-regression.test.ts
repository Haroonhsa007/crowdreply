import { describe, expect, it, vi } from 'vitest';
import { repositoryFixture } from '../db/fake-driver.js';
import { executionInput, syntheticResult } from '../db/fixtures.js';
import { foundationEnv } from '../foundation/fixtures.js';
import { loadConfig } from '../../src/config/index.js';
import { createLogger } from '../../src/logging/index.js';
import { createProviderAdapters } from '../../src/providers/index.js';
import { createMongoBudgetGate } from '../../src/workers/live-budget.js';
import { recoverExecutions } from '../../src/workers/recovery.js';
import { PaidProviderError } from '../../src/providers/paid-error.js';
import {
  processExecution,
  type WorkerDependencies,
} from '../../src/workers/provider-worker.js';

async function fixture() {
  let now = Date.parse('2026-11-02T12:00:00Z');
  const { repository, storage } = repositoryFixture(() => new Date(now));
  const config = loadConfig({
    ...foundationEnv,
    LOG_LEVEL: 'silent',
    MAX_ATTEMPTS: '3',
  });
  const resolver: WorkerDependencies['resolver'] = {
    resolve: async (provider) => ({
      provider,
      mode: 'live',
      keySource: 'env',
      apiKey: 'placeholder-recovery-key',
    }),
  };
  const adapters = createProviderAdapters({ config, resolver, fetch: vi.fn() });
  const execute = vi
    .spyOn(adapters.openai, 'executeResolved')
    .mockResolvedValue({ ...syntheticResult, model: config.OPENAI_MODEL });
  const gate = createMongoBudgetGate(storage.spend);
  const deps: WorkerDependencies = {
    repository,
    config,
    resolver,
    adapters,
    budgetGate: gate,
    logger: createLogger(config),
    pause: vi.fn(),
    schedule: vi.fn(),
    liveBudgetBound: () => 0.05,
    clock: () => now,
    random: () => 0.9,
  };
  const { execution } = await repository.createQueuedIfAbsent({
    ...executionInput,
    model: config.OPENAI_MODEL,
  });
  const payload = {
    executionId: execution.id,
    executionKey: execution.executionKey,
  };
  return {
    repository,
    storage,
    deps,
    execution,
    payload,
    execute,
    gate,
    now: () => new Date(now),
    advance: (ms = 300_000) => {
      now += ms;
    },
  };
}

describe('durable claim, completion, budget and recovery regressions', () => {
  it('retains all partial paid turns and usage after two transient persistence failures', async () => {
    const f = await fixture();
    const turns = [
      { id: 'synthetic-turn-1', usage: { input_tokens: 10, output_tokens: 3 } },
      { id: 'synthetic-turn-2', usage: { input_tokens: 20, output_tokens: 4 } },
    ];
    const partial = {
      rawPayload: { responses: turns },
      answerText: 'Synthetic paid partial answer',
      citations: [],
      usage: { inputTokens: 30, outputTokens: 7, toolCalls: 0 },
      cost: { tokensUsd: 0.012, toolsUsd: 0, totalUsd: 0.012 },
      requestId: 'synthetic-partial',
      completedAt: f.now().toISOString(),
    };
    f.execute.mockRejectedValueOnce(new PaidProviderError('server', partial));
    const store = f.repository.savePartialRaw!.bind(f.repository);
    const persist = vi
      .spyOn(f.repository, 'savePartialRaw')
      .mockRejectedValueOnce(new Error('Synthetic transient write 1'))
      .mockRejectedValueOnce(new Error('Synthetic transient write 2'))
      .mockImplementation(store);
    const delays: number[] = [];
    f.deps.persistenceWait = async (ms) => {
      delays.push(ms);
      f.advance(ms);
    };
    await processExecution(f.payload, f.deps);
    expect(persist).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([250, 500]);
    expect(
      (await f.repository.getRawResponse(f.execution.id))?.body,
    ).toMatchObject({ rawPayload: { responses: turns }, usage: partial.usage });
    expect((await f.repository.getById(f.execution.id))?.status).toBe(
      'unknown_outcome',
    );
    expect(await f.repository.getSpendTotal()).toBe(0.05);
    await processExecution(f.payload, f.deps);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('preserves sanitized persistence uncertainty when reconciliation and gate release also fail', async () => {
    const f = await fixture();
    const privateError = new Error('private-storage-detail-must-not-escape');
    const acquire = f.gate.acquire.bind(f.gate);
    vi.spyOn(f.gate, 'acquire').mockImplementation(async (...args) => {
      const release = await acquire(...args);
      return release
        ? async () => {
            throw privateError;
          }
        : null;
    });
    const get = f.repository.getById.bind(f.repository);
    vi.spyOn(f.repository, 'getById')
      .mockImplementationOnce(get)
      .mockRejectedValue(privateError);
    vi.spyOn(f.repository, 'markUnknownOutcome').mockRejectedValue(
      privateError,
    );
    vi.spyOn(f.repository, 'stageProviderResult').mockRejectedValue(
      privateError,
    );
    f.deps.persistenceWait = async (ms) => {
      f.advance(ms);
    };
    const caught = await processExecution(f.payload, f.deps).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      'Provider response persistence exhausted; outcome requires reconciliation',
    );
    expect(String(caught)).not.toContain(privateError.message);
    expect((caught as Error).cause).toBeUndefined();
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('surfaces a sanitized cleanup error after otherwise successful durable completion', async () => {
    const f = await fixture();
    const acquire = f.gate.acquire.bind(f.gate);
    vi.spyOn(f.gate, 'acquire').mockImplementation(async (...args) => {
      const release = await acquire(...args);
      return release
        ? async () => {
            throw new Error('private-cleanup-storage-detail');
          }
        : null;
    });
    await expect(processExecution(f.payload, f.deps)).rejects.toThrow(
      'Budget gate cleanup failed; reconciliation required',
    );
    expect((await f.repository.getById(f.execution.id))?.status).toBe(
      'succeeded',
    );
    expect((await f.repository.getRawResponse(f.execution.id))?.body).toEqual(
      syntheticResult.rawPayload,
    );
    await recoverExecutions(f.repository, { enqueue: vi.fn() }, f.now());
    expect(await acquire('another-provider')).not.toBeNull();
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('revokes an expired pre-attempt claim before freeing its gate and rejects expired dispatch', async () => {
    const f = await fixture();
    const claim = (await f.repository.claim(f.execution.executionKey, 1))!;
    const fence = { claimToken: claim.claimToken };
    await f.gate.acquire(f.execution.executionKey, fence);
    f.advance(2);
    let attempted = false;
    let attemptRejected = false;
    const find = f.storage.executions.findOne.bind(f.storage.executions);
    vi.spyOn(f.storage.executions, 'findOne').mockImplementation(
      async (filter) => {
        const row = await find(filter);
        if (filter.executionKey === f.execution.executionKey && !attempted) {
          attempted = true;
          try {
            await f.repository.recordAttempt(
              f.execution.id,
              {
                n: 1,
                integration: 'live',
                startedAt: f.now().toISOString(),
                reservationUsd: 0.05,
              },
              fence,
            );
          } catch {
            attemptRejected = true;
          }
        }
        return row;
      },
    );
    await f.repository.recoverBudgetGate!(f.now());
    expect(attempted).toBe(true);
    expect(attemptRejected).toBe(true);
    expect((await f.repository.getById(f.execution.id))?.status).toBe(
      'retry_wait',
    );
    expect(await f.gate.acquire('second-provider')).not.toBeNull();
    await expect(
      f.repository.recordAttempt(
        f.execution.id,
        {
          n: 1,
          integration: 'live',
          startedAt: f.now().toISOString(),
          reservationUsd: 0.05,
        },
        fence,
      ),
    ).rejects.toThrow();
  });

  it('retains a received answer across two pre-commit staging failures', async () => {
    const f = await fixture();
    const stage = f.repository.stageProviderResult!.bind(f.repository);
    const persist = vi
      .spyOn(f.repository, 'stageProviderResult')
      .mockRejectedValueOnce(new Error('Synthetic database outage 1'))
      .mockRejectedValueOnce(new Error('Synthetic database outage 2'))
      .mockImplementation(stage);
    await processExecution(f.payload, f.deps);
    expect(persist).toHaveBeenCalledTimes(3);
    expect((await f.repository.getRawResponse(f.execution.id))?.body).toEqual(
      syntheticResult.rawPayload,
    );
    expect((await f.repository.getById(f.execution.id))?.status).toBe(
      'succeeded',
    );
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps legacy priced-model spend unknown when no proven reservation was persisted', async () => {
    const f = await fixture();
    await f.repository.claim(f.execution.executionKey, 1);
    await f.repository.recordAttempt(f.execution.id, {
      n: 1,
      integration: 'live',
      startedAt: f.now().toISOString(),
    });
    await f.repository.recordSpend({
      executionId: f.execution.id,
      idempotencyKey: `${f.execution.id}:provider:1`,
      stage: 'provider',
      amountUsd: null,
    });
    f.advance(2);
    await recoverExecutions(f.repository, { enqueue: vi.fn() }, f.now());
    expect((await f.repository.getById(f.execution.id))?.status).toBe(
      'unknown_outcome',
    );
    expect(await f.repository.getSpendTotal()).toBeNull();
    await recoverExecutions(f.repository, { enqueue: vi.fn() }, f.now());
    expect(await f.repository.getSpendTotal()).toBeNull();
  });

  it('frees an orphan gate after a rejected HTTP attempt without overwriting its durable retry', async () => {
    const f = await fixture();
    const claim = (await f.repository.claim(f.execution.executionKey, 60_000))!;
    const fence = { claimToken: claim.claimToken };
    await f.gate.acquire(f.execution.executionKey, fence);
    await f.repository.recordAttempt(
      f.execution.id,
      {
        n: 1,
        integration: 'live',
        startedAt: f.now().toISOString(),
        reservationUsd: 0.05,
      },
      fence,
    );
    await f.repository.recordSpend({
      executionId: f.execution.id,
      idempotencyKey: `${f.execution.id}:provider:1`,
      stage: 'provider',
      amountUsd: 0,
    });
    const retryAt = new Date(f.now().getTime() + 3000);
    await f.repository.scheduleRetry(f.execution.id, retryAt, 'server', fence);
    await f.repository.recoverBudgetGate!(f.now());
    const row = (await f.repository.getById(f.execution.id))!;
    expect(row.status).toBe('retry_wait');
    expect(row.retryAt).toBe(retryAt.toISOString());
    expect(await f.gate.acquire('second-provider')).not.toBeNull();
  });

  it('ordinary budget-gate waiting never exhausts failed-dispatch retries', async () => {
    const f = await fixture();
    const release = (await f.gate.acquire('healthy-other-provider'))!;
    for (let i = 0; i < f.deps.config.MAX_ATTEMPTS + 3; i++) {
      await processExecution(f.payload, f.deps);
      f.advance(2001);
    }
    const waiting = (await f.repository.getById(f.execution.id))!;
    expect(waiting.status).toBe('retry_wait');
    expect(waiting.attempts).toHaveLength(0);
    expect(waiting.dispatchCount).toBe(0);
    expect(f.execute).not.toHaveBeenCalled();
    await release();
    await processExecution(f.payload, f.deps);
    expect((await f.repository.getById(f.execution.id))?.status).toBe(
      'succeeded',
    );
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('does not free an observed pre-attempt gate if an attempt appeared before revocation', async () => {
    const f = await fixture();
    const claim = (await f.repository.claim(f.execution.executionKey, 10_000))!;
    const fence = { claimToken: claim.claimToken };
    await f.gate.acquire(f.execution.executionKey, fence);
    const find = f.storage.executions.findOne.bind(f.storage.executions);
    let inserted = false;
    vi.spyOn(f.storage.executions, 'findOne').mockImplementation(
      async (filter) => {
        const snapshot = await find(filter);
        if (filter.executionKey === f.execution.executionKey && !inserted) {
          inserted = true;
          await f.repository.recordAttempt(
            f.execution.id,
            {
              n: 1,
              integration: 'live',
              startedAt: f.now().toISOString(),
              reservationUsd: 0.05,
            },
            fence,
          );
        }
        return snapshot;
      },
    );
    // Recovery's supplied time observes expiry, while the resumed worker still
    // has authority according to the repository clock: exercise the CAS itself.
    await f.repository.recoverBudgetGate!(new Date(f.now().getTime() + 10_001));
    expect(inserted).toBe(true);
    expect(await f.gate.acquire('second-provider')).toBeNull();
    expect((await f.repository.getById(f.execution.id))?.status).toBe(
      'running',
    );
  });

  it('rejects provider dispatch when the lease expires during the reservation write', async () => {
    const f = await fixture();
    const record = f.repository.recordSpend.bind(f.repository);
    vi.spyOn(f.repository, 'recordSpend').mockImplementation(async (value) => {
      await record(value);
      if (value.amountUsd === null) f.advance();
    });
    await processExecution(f.payload, f.deps);
    expect(f.execute).not.toHaveBeenCalled();
    expect(await f.repository.getSpendTotal()).toBe(0);
  });

  it('reports exhausted response persistence as a failure and never redispatches paid work', async () => {
    const f = await fixture();
    const waits: number[] = [];
    f.deps.persistenceWait = async (ms) => {
      waits.push(ms);
      f.advance(ms);
    };
    vi.spyOn(f.repository, 'stageProviderResult').mockRejectedValue(
      new Error('Synthetic persistent store outage'),
    );
    await expect(processExecution(f.payload, f.deps)).rejects.toThrow(
      'Provider response persistence exhausted',
    );
    expect(waits.length).toBeGreaterThan(2);
    expect(waits[1]).toBeGreaterThan(waits[0]!);
    expect((await f.repository.getById(f.execution.id))?.status).toBe(
      'unknown_outcome',
    );
    expect(await f.repository.getRawResponse(f.execution.id)).toBeNull();
    await processExecution(f.payload, f.deps);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await f.repository.getSpendTotal()).toBe(0.05);
  });

  it('recovers a pre-attempt crash on a later dispatch without confusing earlier rejected history', async () => {
    const f = await fixture();
    const first = (await f.repository.claim(f.execution.executionKey, 1000))!;
    await f.repository.recordAttempt(
      f.execution.id,
      {
        n: 1,
        integration: 'live',
        startedAt: f.now().toISOString(),
        reservationUsd: 0.05,
      },
      { claimToken: first.claimToken },
    );
    await f.repository.recordSpend({
      executionId: f.execution.id,
      idempotencyKey: `${f.execution.id}:provider:1`,
      stage: 'provider',
      amountUsd: 0,
    });
    await f.repository.scheduleRetry(f.execution.id, f.now(), 'server', {
      claimToken: first.claimToken,
    });
    const next = (await f.repository.claim(f.execution.executionKey, 1))!;
    await f.gate.acquire(f.execution.executionKey, {
      claimToken: next.claimToken,
    });
    f.advance(2);
    await recoverExecutions(f.repository, { enqueue: vi.fn() }, f.now());
    expect((await f.repository.getById(f.execution.id))?.status).toBe(
      'retry_wait',
    );
    expect(await f.repository.getSpendTotal()).toBe(0);
  });
  it('an old gate release cannot unlock a later acquisition by the same owner', async () => {
    const f = await fixture();
    const releaseOld = (await f.gate.acquire(f.execution.executionKey))!;
    await releaseOld();
    expect(await f.gate.acquire(f.execution.executionKey)).not.toBeNull();
    await releaseOld();
    expect(await f.gate.acquire('other')).toBeNull();
  });

  it('preserves partial raw evidence without recovering it as a successful answer', async () => {
    const f = await fixture();
    const claim = (await f.repository.claim(f.execution.executionKey, 1))!;
    const fence = { claimToken: claim.claimToken };
    await f.repository.recordAttempt(
      f.execution.id,
      {
        n: 1,
        integration: 'live',
        startedAt: f.now().toISOString(),
        reservationUsd: 0.05,
      },
      fence,
    );
    await f.repository.savePartialRaw!(
      f.execution.id,
      {
        executionId: f.execution.id,
        body: { partial: true },
        outputText: 'Incomplete answer',
        citations: [],
        providerResponseId: null,
        createdAt: f.now().toISOString(),
      },
      fence,
    );
    f.advance();
    await recoverExecutions(f.repository, { enqueue: vi.fn() }, f.now());
    expect((await f.repository.getById(f.execution.id))?.status).toBe(
      'unknown_outcome',
    );
    expect(
      (await f.repository.getRawResponse(f.execution.id))?.outputText,
    ).toBe('Incomplete answer');
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(['before-attempt', 'after-terminal'])(
    'releases an orphan gate %s without stealing active ownership',
    async (stage) => {
      const f = await fixture();
      if (stage === 'after-terminal') await processExecution(f.payload, f.deps);
      else await f.repository.claim(f.execution.executionKey, 1);
      const held = await f.gate.acquire(f.execution.executionKey);
      expect(held).not.toBeNull();
      if (stage === 'before-attempt') {
        await recoverExecutions(f.repository, { enqueue: vi.fn() }, f.now());
        expect(await f.gate.acquire('different-provider')).toBeNull();
        f.advance();
      }
      await recoverExecutions(f.repository, { enqueue: vi.fn() }, f.now());
      expect(await f.gate.acquire('different-provider')).not.toBeNull();
    },
  );

  it('does not let stale recovery clear a newly claimed lease or record stale attempts', async () => {
    const f = await fixture();
    const old = (await f.repository.claim(f.execution.executionKey, 1))!;
    f.advance(2);
    const list = f.repository.listRecoverable.bind(f.repository);
    let newer: Awaited<ReturnType<typeof f.repository.claim>>;
    vi.spyOn(f.repository, 'listRecoverable').mockImplementation(
      async (...args) => {
        const snapshot = await list(...args);
        newer = await f.repository.claim(f.execution.executionKey, 60_000);
        return snapshot;
      },
    );
    await recoverExecutions(f.repository, { enqueue: vi.fn() }, f.now());
    const current = (await f.repository.getById(f.execution.id))!;
    expect(current.status).toBe('running');
    expect(current.leaseUntil).toBe(newer!.leaseUntil);
    expect(newer!.claimToken).not.toBe(old.claimToken);
    await expect(
      f.repository.recordAttempt(
        f.execution.id,
        { n: 1, integration: 'live', startedAt: f.now().toISOString() },
        { claimToken: old.claimToken },
      ),
    ).rejects.toThrow();
  });

  it('retains a successful response through transient spend settlement failure and never calls the provider twice', async () => {
    const f = await fixture();
    const record = f.repository.recordSpend.bind(f.repository);
    let failed = false;
    vi.spyOn(f.repository, 'recordSpend').mockImplementation(async (value) => {
      if (value.amountUsd !== null && !failed) {
        failed = true;
        throw new Error('Synthetic ledger outage');
      }
      return record(value);
    });
    await processExecution(f.payload, f.deps);
    expect(
      (await f.repository.getRawResponse(f.execution.id))?.outputText,
    ).toBe(syntheticResult.answerText);
    f.advance();
    await recoverExecutions(f.repository, { enqueue: vi.fn() }, f.now());
    await processExecution(f.payload, f.deps);
    expect((await f.repository.getById(f.execution.id))?.status).toBe(
      'succeeded',
    );
    expect(await f.repository.getSpendTotal()).toBe(
      syntheticResult.cost.totalUsd,
    );
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('finishes a crash after raw insertion with one provider invocation', async () => {
    const f = await fixture();
    const finish = f.repository.saveRawAndComplete.bind(f.repository);
    vi.spyOn(f.repository, 'saveRawAndComplete')
      .mockRejectedValueOnce(new Error('Synthetic crash before finalization'))
      .mockImplementation(finish);
    await processExecution(f.payload, f.deps);
    expect(f.storage.raw.rows).toHaveLength(1);
    f.advance();
    await recoverExecutions(f.repository, { enqueue: vi.fn() }, f.now());
    expect((await f.repository.getById(f.execution.id))?.status).toBe(
      'succeeded',
    );
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('gives every page recovery attention even with 105 persistent paused jobs and a poison row', async () => {
    const f = await fixture();
    const older = f.execution;
    f.advance(1);
    for (let i = 0; i < 105; i++)
      await f.repository.createQueuedIfAbsent({
        ...executionInput,
        questionId: `paused-${i}`,
        provider: 'gemini',
      });
    const visited = new Set<string>();
    const enqueue = vi.fn(async ({ executionId }: { executionId: string }) => {
      visited.add(executionId);
      if (executionId === older.id) throw new Error('Synthetic queue failure');
    });
    let failures = 0;
    for (let i = 0; i < 3; i++) {
      await recoverExecutions(f.repository, { enqueue }, f.now()).catch(
        (error) => {
          expect(String(error)).toContain('Recovery incomplete:');
          failures++;
        },
      );
      f.advance(1);
    }
    expect(failures).toBeGreaterThan(0);
    expect(visited.size).toBe(106);
    expect(visited.has(older.id)).toBe(true);
  });

  it('reconciles terminal null spend even after its gate was released', async () => {
    const f = await fixture();
    await processExecution(f.payload, f.deps);
    await f.storage.spend.updateOne(
      { idempotencyKey: `${f.execution.id}:provider:1` },
      { $set: { amountUsd: null } },
    );
    expect(await f.repository.getSpendTotal()).toBeNull();
    await recoverExecutions(f.repository, { enqueue: vi.fn() }, f.now());
    expect(await f.repository.getSpendTotal()).toBe(
      syntheticResult.cost.totalUsd,
    );
    expect((await f.repository.getById(f.execution.id))?.status).toBe(
      'succeeded',
    );
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('stale full-response writers cannot stage or overwrite a newer claim', async () => {
    const f = await fixture();
    const old = (await f.repository.claim(f.execution.executionKey, 1))!;
    f.advance(2);
    const newer = (await f.repository.claim(f.execution.executionKey, 60_000))!;
    await f.repository.recordAttempt(
      f.execution.id,
      { n: 1, integration: 'live', startedAt: f.now().toISOString() },
      { claimToken: newer.claimToken },
    );
    await expect(
      f.repository.stageProviderResult!(
        f.execution.id,
        {
          executionId: f.execution.id,
          body: syntheticResult.rawPayload,
          outputText: syntheticResult.answerText,
          citations: [],
          providerResponseId: null,
          createdAt: f.now().toISOString(),
        },
        syntheticResult,
        0.01,
        { claimToken: old.claimToken },
      ),
    ).rejects.toThrow();
    expect(f.storage.raw.rows).toHaveLength(0);
    expect((await f.repository.getById(f.execution.id))?.claimToken).toBe(
      newer.claimToken,
    );
  });

  it('bounds repeated infrastructure failures durably without creating paid attempts', async () => {
    const f = await fixture();
    vi.spyOn(f.deps.resolver, 'resolve').mockRejectedValue(
      new Error('Synthetic Redis unavailable'),
    );
    for (let i = 0; i < 5; i++) {
      await processExecution(f.payload, f.deps);
      f.advance();
    }
    const row = (await f.repository.getById(f.execution.id))!;
    expect(row.status).toBe('dead');
    expect(row.dispatchCount).toBe(3);
    expect(row.attempts).toHaveLength(0);
    expect(f.execute).not.toHaveBeenCalled();
  });
});
