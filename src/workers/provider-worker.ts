import { Worker, DelayedError } from 'bullmq';
import { setTimeout as wait } from 'node:timers/promises';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import {
  ProviderError,
  ProviderIdSchema,
  QueueJobPayloadSchema,
  type ExecutionRepository,
  type ProviderKeyResolver,
  type ProviderId,
  type QueueJobPayload,
  type Attempt,
} from '../contracts/index.js';
import {
  buildProviderRequest,
  liveReservationBound,
  type RuntimeAdapter,
} from '../providers/index.js';
import type { LiveBudgetGate } from './live-budget.js';
import { PaidProviderError } from '../providers/paid-error.js';

const RESPONSE_PERSISTENCE_WINDOW_MS = 30_000;
const RESPONSE_PERSISTENCE_MAX_ATTEMPTS = 8;

export interface WorkerDependencies {
  repository: ExecutionRepository;
  resolver: ProviderKeyResolver;
  adapters: Record<ProviderId, RuntimeAdapter>;
  config: Config;
  logger: Logger;
  budgetGate: LiveBudgetGate;
  schedule(payload: QueueJobPayload, delayMs: number): Promise<void>;
  pause(provider: ProviderId): Promise<void>;
  clock?: () => number;
  random?: () => number;
  /** Synthetic tests may supply a proven fixture bound; production uses the verified provider bound. */
  liveBudgetBound?: (provider: ProviderId, model: string) => number | null;
  /** Clock-controlled tests can advance backoff without wall-clock delays. */
  persistenceWait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

class ProcessingFailure extends Error {}
class EvidencePersistenceFailure extends Error {
  constructor(readonly writes: number) {
    super('Response evidence persistence exhausted');
  }
}

/** Full and partial paid responses share the same bounded in-memory recovery. */
async function persistEvidence(
  write: () => Promise<void>,
  deps: WorkerDependencies,
  signal: AbortSignal,
): Promise<void> {
  const now = deps.clock ?? Date.now;
  const deadline = now() + RESPONSE_PERSISTENCE_WINDOW_MS;
  for (
    let attempt = 0;
    attempt < RESPONSE_PERSISTENCE_MAX_ATTEMPTS;
    attempt++
  ) {
    if (attempt > 0 && now() >= deadline)
      throw new EvidencePersistenceFailure(attempt);
    try {
      await write();
      return;
    } catch {
      const remaining = deadline - now();
      if (
        attempt === RESPONSE_PERSISTENCE_MAX_ATTEMPTS - 1 ||
        remaining <= 0 ||
        signal.aborted
      )
        throw new EvidencePersistenceFailure(attempt + 1);
      const delay = Math.min(250 * 2 ** attempt, 5000, remaining);
      try {
        if (deps.persistenceWait) await deps.persistenceWait(delay, signal);
        else await wait(delay, undefined, { signal });
      } catch {
        throw new EvidencePersistenceFailure(attempt + 1);
      }
    }
  }
}
export async function processExecution(
  payload: QueueJobPayload,
  deps: WorkerDependencies,
  signal = new AbortController().signal,
): Promise<void> {
  const { repository, config } = deps;
  const now = deps.clock ?? Date.now;
  const prior = await repository.getById(payload.executionId);
  if (!prior || prior.executionKey !== payload.executionKey) return;
  if (prior.completionPending) {
    if (prior.leaseUntil && Date.parse(prior.leaseUntil) <= now())
      await repository.reconcileCompletion?.(prior.id, {
        claimToken: prior.claimToken,
        leaseUntil: prior.leaseUntil,
      });
    return;
  }
  if (
    prior.status === 'running' &&
    prior.leaseUntil &&
    Date.parse(prior.leaseUntil) <= now() &&
    prior.integration === 'live' &&
    (prior.claimAttemptRecorded ?? prior.attempts.length > 0)
  ) {
    await repository.markUnknownOutcome(prior.id, {
      claimToken: prior.claimToken,
      leaseUntil: prior.leaseUntil,
    });
    return;
  }
  const execution = await repository.claim(
    payload.executionKey,
    config.PROVIDER_TIMEOUT_MS * 4 + RESPONSE_PERSISTENCE_WINDOW_MS + 15000,
  );
  if (!execution) return;
  const fence = { claimToken: execution.claimToken };
  if ((execution.dispatchCount ?? 1) > config.MAX_ATTEMPTS) {
    await repository.markDead(
      execution.id,
      {
        category: 'server',
        retryable: false,
        message: 'Dispatch retry limit reached',
      },
      fence,
    );
    return;
  }
  const logger = deps.logger.child({
    correlationId: execution.id,
    executionId: execution.id,
    provider: execution.provider,
  });
  let release: (() => Promise<void>) | null = null;
  let attempt: Attempt | undefined;
  let live = false;
  let called = false;
  let responseReceived = false;
  let responseStored = false;
  let attemptRecorded = false;
  let primaryFailure: ProcessingFailure | undefined;
  let deferredFailure: ProcessingFailure | undefined;
  let reservationUsd = config.LIVE_CALL_RESERVE_USD;
  const spendId = () => `${execution.id}:provider:${attempt?.n ?? 0}`;
  try {
    try {
      const access = await deps.resolver.resolve(execution.provider);
      live = access.mode === 'live';
      if (execution.integration && execution.integration !== access.mode)
        throw new ProviderError({
          category: 'invalid_request',
          retryable: false,
          message: 'Execution mode changed; submit a deliberate rerun',
        });
      if (live) {
        release = await deps.budgetGate.acquire(execution.executionKey, fence);
        if (!release) {
          const delay = config.RETRY_BASE_MS;
          if (!repository.deferForBudget)
            throw new Error('Budget waiting storage unavailable');
          await repository.deferForBudget(
            execution.id,
            new Date(now() + delay),
            fence,
          );
          await deps.schedule(payload, delay);
          return;
        }
        const total = await repository.getSpendTotal();
        const bound = (deps.liveBudgetBound ?? liveReservationBound)(
          execution.provider,
          execution.model,
        );
        reservationUsd = Math.max(config.LIVE_CALL_RESERVE_USD, bound ?? 0);
        if (
          total === null ||
          bound === null ||
          !Number.isFinite(bound) ||
          bound <= 0 ||
          total + reservationUsd > config.SPEND_CAP_USD
        ) {
          throw new ProviderError({
            category: 'auth',
            retryable: false,
            message: 'Live budget unavailable or exceeded',
          });
        }
      }
      attempt = {
        n: execution.attempts.length + 1,
        integration: access.mode,
        startedAt: new Date(now()).toISOString(),
        ...(live ? { reservationUsd } : {}),
      };
      await repository.recordAttempt(execution.id, attempt, fence);
      attemptRecorded = true;
      // Persist uncertainty before a paid request. Crashes/unknown charges fail closed.
      if (live)
        await repository.recordSpend({
          executionId: execution.id,
          idempotencyKey: spendId(),
          stage: 'provider',
          amountUsd: null,
        });
      if (!repository.assertDispatch)
        throw new Error('Dispatch authority storage unavailable');
      await repository.assertDispatch(execution.id, fence);
      called = true;
      const result = await deps.adapters[execution.provider].executeResolved(
        buildProviderRequest(execution, config),
        signal,
        access,
      );
      responseReceived = true;
      const raw = {
        executionId: execution.id,
        body: result.rawPayload,
        outputText: result.answerText,
        citations: result.citations,
        providerResponseId: result.requestId,
        createdAt: result.completedAt,
      };
      if (!repository.stageProviderResult)
        throw new Error('Completion evidence storage unavailable');
      // Keep the received response in memory through bounded exponential backoff.
      // Responsibility moves to recovery only after durable evidence is verified.
      await persistEvidence(
        async () => {
          await repository.stageProviderResult!(
            execution.id,
            raw,
            result,
            result.cost.totalUsd ?? reservationUsd,
            fence,
          );
        },
        deps,
        signal,
      );
      responseStored = true;
      // Settle before making the execution terminal, so a crash cannot strand a
      // null ledger row on a succeeded execution that recovery would skip.
      if (live)
        await repository.recordSpend({
          executionId: execution.id,
          idempotencyKey: spendId(),
          stage: 'provider',
          amountUsd: result.cost.totalUsd ?? reservationUsd,
        });
      await repository.saveRawAndComplete(
        execution.id,
        {
          executionId: execution.id,
          body: result.rawPayload,
          outputText: result.answerText,
          citations: result.citations,
          providerResponseId: result.requestId,
          createdAt: result.completedAt,
        },
        result,
        fence,
      );
      logger.info(
        {
          stage: 'completed',
          attempt: attempt.n,
          integration: result.integration,
        },
        'Execution completed',
      );
    } catch (error) {
      if (responseReceived) {
        // A staging write may have committed before its acknowledgement failed.
        if (!responseStored) {
          try {
            const persisted = await repository.getById(execution.id);
            responseStored =
              persisted !== null &&
              persisted?.claimToken === execution.claimToken &&
              persisted.completionPending === true;
          } catch {
            /* An unavailable store cannot establish a durable handoff. */
          }
        }
        logger.error(
          {
            stage: responseStored ? 'completion.pending' : 'response.unstored',
          },
          responseStored
            ? 'Stored response completion needs reconciliation'
            : 'Received response could not be persisted; outcome requires reconciliation',
        );
        if (!responseStored) {
          // Mark uncertainty if the store is available, but never claim the raw
          // answer survived. Forced shutdown/permanent store loss can lose memory.
          try {
            await repository.markUnknownOutcome(execution.id, fence);
          } catch {
            /* The expired attempt remains recoverable and must not be replayed. */
          }
          throw new ProcessingFailure(
            'Provider response persistence exhausted; outcome requires reconciliation',
          );
        }
        return;
      }
      const normalized =
        error instanceof ProviderError
          ? error
          : new ProviderError({
              category: called ? 'unknown' : 'server',
              retryable: !called,
              message: 'Execution processing failed',
            });
      const httpErrorResponse =
        error instanceof ProviderError &&
        error.httpStatus !== undefined &&
        error.httpStatus >= 400 &&
        error.httpStatus <= 599;
      if (!called && live && attemptRecorded) {
        // Authority failed before dispatch, so this attempt made no paid call.
        await repository.recordSpend({
          executionId: execution.id,
          idempotencyKey: spendId(),
          stage: 'provider',
          amountUsd: 0,
        });
      }
      if (called && live && error instanceof PaidProviderError) {
        const partial = {
          executionId: execution.id,
          body: { ...error.partial, rawPayload: error.partial.rawPayload },
          outputText: error.partial.answerText,
          citations: error.partial.citations,
          providerResponseId: error.partial.requestId,
          createdAt: error.partial.completedAt,
        };
        try {
          await persistEvidence(
            async () => {
              if (!repository.savePartialRaw)
                throw new Error(
                  'Partial provider evidence storage unavailable',
                );
              await repository.savePartialRaw(execution.id, partial, fence);
            },
            deps,
            signal,
          );
        } catch (failure) {
          deferredFailure = new ProcessingFailure(
            'Partial response persistence exhausted; outcome requires reconciliation',
          );
          logger.error(
            {
              stage: 'partial_evidence.unstored',
              writes:
                failure instanceof EvidencePersistenceFailure
                  ? failure.writes
                  : 0,
            },
            'Partial response evidence could not be persisted; reconciliation required',
          );
        }
      }
      if (deferredFailure) {
        // Each reconciliation step is independent: a settlement outage must not
        // prevent marking uncertainty if the status write can still succeed.
        try {
          await repository.recordSpend({
            executionId: execution.id,
            idempotencyKey: spendId(),
            stage: 'provider',
            amountUsd: Math.max(
              reservationUsd,
              error instanceof PaidProviderError
                ? (error.partial.cost.totalUsd ?? 0)
                : 0,
            ),
          });
        } catch {
          logger.error(
            { stage: 'partial_accounting.pending' },
            'Paid accounting requires reconciliation',
          );
        }
        try {
          await repository.markUnknownOutcome(execution.id, fence);
        } catch {
          logger.error(
            { stage: 'partial_outcome.pending' },
            'Paid execution outcome requires reconciliation',
          );
        }
        throw deferredFailure;
      }
      if (called && live && attempt) {
        await repository.recordSpend({
          executionId: execution.id,
          idempotencyKey: spendId(),
          stage: 'provider',
          amountUsd: httpErrorResponse
            ? 0
            : Math.max(
                reservationUsd,
                error instanceof PaidProviderError
                  ? (error.partial.cost.totalUsd ?? 0)
                  : 0,
              ),
        });
      }
      const uncertain = called && live && !httpErrorResponse;
      // A live timeout/no-response may already have been paid for. Reserve its
      // worst case, mark unknown_outcome, and never auto-retry it to avoid paying twice.
      if (uncertain) {
        await repository.markUnknownOutcome(execution.id, fence);
        logger.error(
          { stage: 'unknown_outcome' },
          'Paid request needs reconciliation',
        );
      } else if (
        normalized.retryable &&
        (called ? (attempt?.n ?? 0) : (execution.dispatchCount ?? 1)) <
          config.MAX_ATTEMPTS
      ) {
        const ceiling = Math.min(
          config.RETRY_MAX_MS,
          config.RETRY_BASE_MS * 2 ** Math.max(0, (attempt?.n ?? 1) - 1),
        );
        const delay = Math.max(
          normalized.retryAfterMs ?? 0,
          Math.floor((deps.random ?? Math.random)() * ceiling),
        );
        await repository.scheduleRetry(
          execution.id,
          new Date(now() + delay),
          normalized.category,
          fence,
        );
        await deps.schedule(payload, delay);
      } else
        await repository.markDead(
          execution.id,
          {
            category: normalized.category,
            retryable: false,
            message: normalized.message,
          },
          fence,
        );
      if (live && normalized.category === 'auth') {
        await deps.pause(execution.provider);
        logger.error(
          { stage: 'provider.paused' },
          'Provider paused: credentials, credit or budget need attention',
        );
      }
      logger.warn(
        {
          stage: 'attempt.failed',
          category: normalized.category,
          attempt: attempt?.n,
        },
        'Execution attempt failed',
      );
    }
  } catch (error) {
    primaryFailure =
      deferredFailure ??
      (error instanceof ProcessingFailure
        ? error
        : new ProcessingFailure(
            'Execution processing failed; reconciliation required',
          ));
    throw primaryFailure;
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        logger.error(
          { stage: 'budget_gate.cleanup_failed' },
          'Budget gate cleanup requires reconciliation',
        );
        if (!primaryFailure)
          throw new ProcessingFailure(
            'Budget gate cleanup failed; reconciliation required',
          );
      }
    }
  }
}

export function createProviderWorkers(
  connection: Redis,
  dependencies: Omit<WorkerDependencies, 'schedule'>,
) {
  const controller = new AbortController();
  const workers = ProviderIdSchema.options.map(
    (provider) =>
      new Worker<QueueJobPayload>(
        `provider-${provider}`,
        async (job, token) => {
          let delayed = false;
          await processExecution(
            QueueJobPayloadSchema.parse(job.data),
            {
              ...dependencies,
              schedule: async (_payload, delay) => {
                await job.moveToDelayed(Date.now() + delay, token);
                delayed = true;
              },
            },
            controller.signal,
          );
          if (delayed) throw new DelayedError();
        },
        { connection, concurrency: dependencies.config.WORKER_CONCURRENCY },
      ),
  );
  for (const worker of workers)
    worker.on('error', () =>
      dependencies.logger.error(
        { stage: 'worker.error' },
        'Worker transport failed',
      ),
    );
  return {
    isRunning: () => workers.every((worker) => worker.isRunning()),
    async close() {
      const timeout = setTimeout(
        () => controller.abort(),
        dependencies.config.PROVIDER_TIMEOUT_MS + 1000,
      ).unref();
      try {
        await Promise.all(workers.map((worker) => worker.close()));
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
