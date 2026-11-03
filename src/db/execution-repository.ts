import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import {
  buildExecutionKey,
  CreateExecutionInputSchema,
  ExecutionSchema,
  RawResponseSchema,
  ProviderResultSchema,
  type ProviderResult,
  type ClaimFence,
  type ExecutionRepository,
  type Execution,
  type RawResponse,
  type SpendRecord,
  SpendRecordSchema,
} from '../contracts/index.js';
import { LIVE_BUDGET_LEDGER_KEY } from './spend-reservation.js';

export type Row = Record<string, unknown>;
export interface CollectionPort {
  findOne(filter: Row): Promise<Row | null>;
  insertOne(row: Row): Promise<unknown>;
  updateOne(
    filter: Row,
    update: Row,
    options?: { upsert?: boolean },
  ): Promise<{ matchedCount: number }>;
  findOneAndUpdate(
    filter: Row,
    update: Row,
    options?: { returnDocument: 'after' },
  ): Promise<Row | null>;
  find(filter: Row): {
    sort(sort: Record<string, 1 | -1>): {
      limit(limit: number): { toArray(): Promise<Row[]> };
    };
  };
  aggregate(pipeline: Row[]): { toArray(): Promise<Row[]> };
}
export interface RepositoryStorage {
  executions: CollectionPort;
  raw: CollectionPort;
  spend: CollectionPort;
  questions: CollectionPort;
}
export function mongoStorage(db: Db): RepositoryStorage {
  return {
    executions: db.collection<Row>('executions'),
    raw: db.collection<Row>('raw_responses'),
    spend: db.collection<Row>('spend_ledger'),
    questions: db.collection<Row>('questions'),
  };
}
const toExecution = (row: Row): Execution => ExecutionSchema.parse(row);
const toRaw = (row: Row): RawResponse =>
  RawResponseSchema.parse({
    ...row,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : row.createdAt,
  });
const duplicate = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 11000;

export function createExecutionRepository(
  storage: RepositoryStorage,
  clock: () => Date = () => new Date(),
): ExecutionRepository {
  const { executions, raw, spend, questions } = storage;
  const getById = async (id: string) => {
    const row = await executions.findOne({ id });
    return row ? toExecution(row) : null;
  };
  const getRequired = async (id: string) => {
    const value = await getById(id);
    if (!value) throw new Error('Execution not found');
    return value;
  };
  const now = () => clock().toISOString();
  const ownership = (fence?: ClaimFence): Row =>
    fence
      ? {
          claimToken: fence.claimToken ?? { $exists: false },
          ...(fence.leaseUntil ? { leaseUntil: fence.leaseUntil } : {}),
        }
      : {};
  const matchesFence = (row: Row, fence?: ClaimFence) =>
    !fence ||
    (row.claimToken === fence.claimToken &&
      (!fence.leaseUntil || row.leaseUntil === fence.leaseUntil));
  const recordSpend = async (value: SpendRecord): Promise<void> => {
    const parsed = SpendRecordSchema.safeParse(value);
    if (!parsed.success) throw new Error('Invalid spend record');
    const record = parsed.data;
    const execution = await getRequired(record.executionId);
    const integration = execution.integration;
    if (!integration) throw new Error('Execution mode has not been recorded');
    try {
      await spend.updateOne(
        { idempotencyKey: record.idempotencyKey },
        {
          $setOnInsert: {
            ...record,
            integration,
            amountUsd: integration === 'mock' ? 0 : record.amountUsd,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if (!duplicate(error)) throw error;
    }
    // Settlement is monotonic: null -> numeric once, never numeric -> another amount.
    if (record.amountUsd !== null)
      await spend.updateOne(
        {
          idempotencyKey: record.idempotencyKey,
          executionId: record.executionId,
          amountUsd: null,
        },
        { $set: { amountUsd: integration === 'mock' ? 0 : record.amountUsd } },
      );
  };
  const materializeRaw = async (row: Row): Promise<Row> => {
    const response = RawResponseSchema.parse(row.completionRaw);
    const result = ProviderResultSchema.parse(row.completionResult);
    try {
      await raw.updateOne(
        { executionId: response.executionId },
        {
          $setOnInsert: {
            ...response,
            _id: randomUUID(),
            createdAt: new Date(response.createdAt),
            evidenceType: 'complete',
            completionResult: result,
            completionSettlementUsd: row.completionSettlementUsd,
            claimToken: row.claimToken,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if (!duplicate(error)) throw error;
    }
    const saved = await raw.findOne({ executionId: response.executionId });
    if (
      !saved ||
      saved.evidenceType !== 'complete' ||
      saved.claimToken !== row.claimToken
    )
      throw new Error('Conflicting response evidence');
    return saved;
  };
  const stageProviderResult = async (
    id: string,
    response: RawResponse,
    result: ProviderResult,
    settlementUsd: number | null,
    fence?: ClaimFence,
  ) => {
    const safeRaw = RawResponseSchema.parse(response);
    // Completion needs metadata only. The untouched body and answer live in
    // completionRaw, then raw_responses; avoid duplicating large payloads.
    const safeResult = ProviderResultSchema.parse({
      ...result,
      rawPayload: null,
      answerText: '',
    });
    if (
      safeRaw.executionId !== id ||
      (settlementUsd !== null &&
        (!Number.isFinite(settlementUsd) || settlementUsd < 0))
    )
      throw new Error('Invalid completion evidence');
    // One document CAS fences both the response and the right to complete it.
    // A crash before raw insertion leaves this staged evidence recoverable.
    await executions.updateOne(
      {
        id,
        status: 'running',
        integration: result.integration,
        completionPending: { $ne: true },
        ...ownership(fence),
      },
      {
        $set: {
          completionPending: true,
          completionRaw: safeRaw,
          completionResult: safeResult,
          completionSettlementUsd: settlementUsd,
          updatedAt: now(),
        },
      },
    );
    const staged = await executions.findOne({ id });
    if (
      !staged ||
      !matchesFence(staged, fence) ||
      staged.completionPending !== true ||
      staged.status !== 'running'
    )
      throw new Error('Execution claim changed');
    await materializeRaw(staged);
  };
  const finalize = async (row: Row): Promise<boolean> => {
    const result = ProviderResultSchema.parse(row.completionResult);
    const saved = await materializeRaw(row);
    const completed = await executions.updateOne(
      {
        id: row.id,
        status: 'running',
        completionPending: true,
        ...ownership({
          claimToken:
            typeof row.claimToken === 'string' ? row.claimToken : undefined,
        }),
      },
      {
        $set: {
          status: 'succeeded',
          rawResponseId: String(saved._id),
          extractionStatus: 'pending',
          usage: result.usage,
          cost: result.cost,
          latencyMs: result.latencyMs,
          citationsAvailable: result.citationsAvailable,
          completedAt: result.completedAt,
          completionPending: false,
          updatedAt: now(),
        },
        $unset: {
          leaseUntil: '',
          retryAt: '',
          completionRaw: '',
          completionResult: '',
          completionSettlementUsd: '',
        },
      },
    );
    return completed.matchedCount === 1;
  };
  const repository: ExecutionRepository = {
    async createQueuedIfAbsent(value) {
      const input = CreateExecutionInputSchema.parse(value);
      const executionKey = buildExecutionKey({
        questionId: input.questionId,
        questionVersion: input.questionVersion,
        provider: input.provider,
        modelSettingsVersion: input.modelSettingsVersion,
        runDate: input.runDate,
        runSeq: input.runSeq,
      });
      const execution = ExecutionSchema.parse({
        ...input,
        id: randomUUID(),
        executionKey,
        status: 'queued',
        extractionStatus: 'pending',
        attempts: [],
        citationsAvailable: 'unknown',
        createdAt: now(),
        updatedAt: now(),
        dispatchCount: 0,
        lastRecoveryTouch: now(),
      });
      try {
        await executions.insertOne({ ...execution, _id: execution.id });
      } catch (error) {
        if (!duplicate(error)) throw error;
        const row = await executions.findOne({ executionKey });
        if (!row)
          throw new Error('Duplicate execution could not be reconciled');
        return { execution: toExecution(row), created: false };
      }
      await questions.updateOne(
        {
          questionId: input.questionId,
          questionVersion: input.questionVersion,
        },
        {
          $setOnInsert: {
            questionId: input.questionId,
            questionVersion: input.questionVersion,
            questionText: input.questionText,
          },
        },
        { upsert: true },
      );
      return { execution, created: true };
    },
    getById,
    async getRawResponse(executionId) {
      const row = await raw.findOne({ executionId });
      return row ? toRaw(row) : null;
    },
    async listRecent(query) {
      if (
        !Number.isInteger(query.limit) ||
        query.limit < 1 ||
        query.limit > 100
      )
        throw new Error('Invalid page limit');
      const filter: Row = {};
      if (query.provider) filter.provider = query.provider;
      if (query.status) filter.status = query.status;
      if (query.before) {
        const cursor = await executions.findOne({ id: query.before });
        if (!cursor) throw new Error('Invalid page cursor');
        filter.$or = [
          { createdAt: { $lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
        ];
      }
      return (
        await executions
          .find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .limit(query.limit)
          .toArray()
      ).map(toExecution);
    },
    async claim(executionKey, leaseMs) {
      if (!Number.isFinite(leaseMs) || leaseMs <= 0)
        throw new Error('Invalid lease');
      const time = now();
      // An expired LIVE attempt is never claimed again: recovery marks unknown_outcome.
      const row = await executions.findOneAndUpdate(
        {
          executionKey,
          completionPending: { $ne: true },
          $or: [
            { status: 'queued' },
            { status: 'retry_wait', retryAt: { $lte: time } },
            {
              status: 'running',
              leaseUntil: { $lte: time },
              $or: [
                { integration: 'mock' },
                { attempts: { $size: 0 } },
                { claimAttemptRecorded: false },
              ],
            },
          ],
        },
        {
          $set: {
            status: 'running',
            leaseUntil: new Date(clock().getTime() + leaseMs).toISOString(),
            updatedAt: time,
            claimToken: randomUUID(),
            claimAttemptRecorded: false,
          },
          $inc: { dispatchCount: 1 },
        },
        { returnDocument: 'after' },
      );
      return row ? toExecution(row) : null;
    },
    async recordAttempt(executionId, attempt, fence) {
      const result = await executions.updateOne(
        {
          id: executionId,
          status: 'running',
          ...ownership(fence),
          $and: [{ leaseUntil: { $gt: now() } }],
          completionPending: { $ne: true },
          $or: [
            { integration: { $exists: false } },
            { integration: attempt.integration },
          ],
        },
        {
          $push: { attempts: attempt },
          $set: {
            updatedAt: now(),
            integration: attempt.integration,
            claimAttemptRecorded: true,
          },
        },
      );
      if (!result.matchedCount)
        throw new Error('Execution mode or state changed');
    },
    async assertDispatch(id, fence) {
      const current = await executions.updateOne(
        {
          id,
          status: 'running',
          completionPending: { $ne: true },
          ...ownership(fence),
          $and: [{ leaseUntil: { $gt: now() } }],
        },
        { $set: { dispatchAuthorizedAt: now() } },
      );
      if (!current.matchedCount)
        throw new Error('Execution dispatch authority expired');
    },
    async deferForBudget(id, retryAt, fence) {
      const deferred = await executions.updateOne(
        {
          id,
          status: 'running',
          dispatchCount: { $gte: 1 },
          completionPending: { $ne: true },
          ...ownership(fence),
          $and: [{ leaseUntil: { $gt: now() } }],
        },
        {
          $set: {
            status: 'retry_wait',
            retryAt: retryAt.toISOString(),
            lastErrorCategory: 'rate_limit',
            updatedAt: now(),
          },
          $unset: { leaseUntil: '' },
          $inc: { dispatchCount: -1 },
        },
      );
      if (!deferred.matchedCount)
        throw new Error('Execution budget wait authority expired');
    },
    async savePartialRaw(executionId, response, fence) {
      const existing = await executions.findOne({
        id: executionId,
        ...ownership(fence),
      });
      if (
        !existing ||
        existing.status !== 'running' ||
        existing.integration !== 'live' ||
        existing.completionPending
      )
        throw new Error('Execution state changed');
      try {
        await raw.updateOne(
          { executionId },
          {
            $setOnInsert: {
              ...response,
              executionId,
              _id: randomUUID(),
              createdAt: new Date(response.createdAt),
              evidenceType: 'partial',
              claimToken: existing.claimToken,
            },
          },
          { upsert: true },
        );
      } catch (error) {
        if (!duplicate(error)) throw error;
      }
      const saved = await raw.findOne({ executionId });
      if (!saved) throw new Error('Raw persistence failed');
      await executions.updateOne(
        {
          id: executionId,
          status: 'running',
          integration: 'live',
          ...ownership(fence),
        },
        { $set: { rawResponseId: String(saved._id), updatedAt: now() } },
      );
    },
    stageProviderResult,
    async saveRawAndComplete(executionId, response, result, fence) {
      const existing = await getRequired(executionId);
      if (existing.status === 'succeeded') return existing;
      const row = await executions.findOne({ id: executionId });
      if (!row?.completionPending)
        await stageProviderResult(
          executionId,
          response,
          result,
          result.cost.totalUsd,
          fence,
        );
      const staged = await executions.findOne({ id: executionId });
      if (!staged || !matchesFence(staged, fence) || !(await finalize(staged)))
        throw new Error('Execution claim changed');
      return getRequired(executionId);
    },
    async reconcileCompletion(id, fence) {
      const row = await executions.findOne({ id });
      if (!row || !row.completionPending || !matchesFence(row, fence))
        return false;
      await materializeRaw(row);
      const execution = toExecution(row);
      if (execution.integration === 'live') {
        const attempt = execution.attempts.at(-1);
        if (!attempt) throw new Error('Completion has no recorded attempt');
        await recordSpend({
          executionId: id,
          idempotencyKey: `${id}:provider:${attempt.n}`,
          stage: 'provider',
          amountUsd:
            typeof row.completionSettlementUsd === 'number'
              ? row.completionSettlementUsd
              : null,
        });
      }
      return finalize(row);
    },
    async markDead(id, error, fence) {
      await executions.updateOne(
        {
          id,
          status: { $nin: ['succeeded', 'unknown_outcome'] },
          completionPending: { $ne: true },
          ...ownership(fence),
        },
        {
          $set: {
            status: 'dead',
            lastErrorCategory: error.category,
            updatedAt: now(),
          },
          $unset: { leaseUntil: '', retryAt: '' },
        },
      );
    },
    async markUnknownOutcome(id, fence) {
      const row = await executions.findOne({ id, ...ownership(fence) });
      if (!row || row.status === 'succeeded' || row.completionPending) return;
      const execution = toExecution(row);
      const attempt = execution.attempts.at(-1);
      // First freeze the observed claim. A stale recovery snapshot cannot settle
      // or release a newer claim's paid attempt.
      const changed = await executions.updateOne(
        {
          id,
          status: row.status,
          completionPending: { $ne: true },
          ...ownership(
            fence ?? {
              claimToken: execution.claimToken,
              leaseUntil: execution.leaseUntil,
            },
          ),
        },
        {
          $set: {
            status: 'unknown_outcome',
            updatedAt: now(),
            accountingPending: execution.integration === 'live',
          },
          $unset: { leaseUntil: '', retryAt: '' },
        },
      );
      if (!changed.matchedCount) return;
      if (execution.integration === 'live' && attempt) {
        await recordSpend({
          executionId: id,
          idempotencyKey: `${id}:provider:${attempt.n}`,
          stage: 'provider',
          amountUsd: attempt.reservationUsd ?? null,
        });
      }
      await executions.updateOne(
        {
          id,
          status: 'unknown_outcome',
          ...ownership({ claimToken: execution.claimToken }),
        },
        { $set: { accountingPending: false } },
      );
      await spend.updateOne(
        {
          idempotencyKey: LIVE_BUDGET_LEDGER_KEY,
          state: 'held',
          owner: execution.executionKey,
          $or: [
            { claimToken: execution.claimToken },
            { claimToken: { $exists: false } },
          ],
        },
        {
          $set: { state: 'free' },
          $unset: { owner: '', claimToken: '', gateToken: '' },
        },
      );
    },
    async scheduleRetry(id, retryAt, lastErrorCategory, fence) {
      await executions.updateOne(
        {
          id,
          status: 'running',
          completionPending: { $ne: true },
          ...ownership(fence),
        },
        {
          $set: {
            status: 'retry_wait',
            retryAt: retryAt.toISOString(),
            lastErrorCategory,
            updatedAt: now(),
          },
          $unset: { leaseUntil: '' },
        },
      );
    },
    async listRecoverable(time, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error('Invalid recovery limit');
      return (
        await executions
          .find({
            $or: [
              { status: 'queued' },
              { status: 'retry_wait', retryAt: { $lte: time.toISOString() } },
              { status: 'running', leaseUntil: { $lte: time.toISOString() } },
              { accountingPending: true },
            ],
          })
          .sort({ lastRecoveryTouch: 1, createdAt: 1, _id: 1 })
          .limit(limit)
          .toArray()
      ).map(toExecution);
    },
    async touchRecovery(id, time) {
      await executions.updateOne(
        { id },
        { $set: { lastRecoveryTouch: time.toISOString() } },
      );
    },
    async recoverBudgetGate(time) {
      // Terminal rows are excluded from execution recovery, but their ledger may
      // still contain an interrupted settlement. Rotate a bounded ledger page.
      const unresolved = await spend
        .find({ integration: 'live', stage: 'provider', amountUsd: null })
        .sort({ lastRecoveryTouch: 1, idempotencyKey: 1 })
        .limit(100)
        .toArray();
      for (const charge of unresolved) {
        await spend.updateOne(
          { idempotencyKey: charge.idempotencyKey },
          { $set: { lastRecoveryTouch: time.toISOString() } },
        );
        if (typeof charge.executionId !== 'string') continue;
        const execution = await getById(charge.executionId);
        if (
          !execution ||
          !['succeeded', 'unknown_outcome', 'dead'].includes(execution.status)
        )
          continue;
        const attempt = execution.attempts.find(
          (value) =>
            charge.idempotencyKey === `${execution.id}:provider:${value.n}`,
        );
        if (!attempt) continue;
        const saved = await raw.findOne({ executionId: execution.id });
        const amount =
          execution.status === 'succeeded' &&
          attempt.n === execution.attempts.at(-1)?.n
            ? typeof saved?.completionSettlementUsd === 'number'
              ? saved.completionSettlementUsd
              : (execution.cost?.totalUsd ?? attempt.reservationUsd ?? null)
            : (attempt.reservationUsd ?? null);
        await recordSpend({
          executionId: execution.id,
          idempotencyKey: String(charge.idempotencyKey),
          stage: 'provider',
          amountUsd: amount,
        });
      }
      const gate = await spend.findOne({
        idempotencyKey: LIVE_BUDGET_LEDGER_KEY,
        state: 'held',
      });
      if (!gate || typeof gate.owner !== 'string') return;
      const row = await executions.findOne({ executionKey: gate.owner });
      if (!row) return; // Unknown ownership fails closed for operator reconciliation.
      const execution = toExecution(row);
      const currentOwner =
        gate.claimToken === undefined ||
        gate.claimToken === execution.claimToken;
      if (
        currentOwner &&
        execution.status === 'running' &&
        execution.leaseUntil &&
        execution.leaseUntil > time.toISOString()
      )
        return;
      if (currentOwner) {
        const fence = {
          claimToken: execution.claimToken,
          leaseUntil: execution.leaseUntil,
        };
        if (row.completionPending) {
          if (!(await repository.reconcileCompletion!(execution.id, fence)))
            return;
        } else if (
          execution.status === 'running' &&
          !(execution.claimAttemptRecorded ?? execution.attempts.length > 0)
        ) {
          // Revoke before releasing the gate. The observed no-attempt snapshot
          // must still be true; a resumed worker cannot progress on this claim.
          const revoked = await executions.updateOne(
            {
              id: execution.id,
              status: 'running',
              ...(execution.claimAttemptRecorded === false
                ? { claimAttemptRecorded: false }
                : { attempts: { $size: 0 } }),
              completionPending: { $ne: true },
              ...ownership(fence),
              $and: [{ leaseUntil: { $lte: time.toISOString() } }],
            },
            {
              $set: {
                status: 'retry_wait',
                retryAt: time.toISOString(),
                lastErrorCategory: 'timeout',
                updatedAt: now(),
              },
              $unset: { leaseUntil: '' },
            },
          );
          if (!revoked.matchedCount) return;
        } else if (
          execution.integration === 'live' &&
          execution.attempts.length
        ) {
          const attempt = execution.attempts.at(-1)!;
          const idempotencyKey = `${execution.id}:provider:${attempt.n}`;
          const charge = await spend.findOne({ idempotencyKey });
          const closedRejectedAttempt =
            ['retry_wait', 'dead'].includes(execution.status) &&
            charge?.amountUsd === 0;
          if (execution.status === 'succeeded') {
            const saved = await raw.findOne({ executionId: execution.id });
            const amount =
              typeof saved?.completionSettlementUsd === 'number'
                ? saved.completionSettlementUsd
                : (execution.cost?.totalUsd ?? attempt.reservationUsd ?? null);
            await recordSpend({
              executionId: execution.id,
              idempotencyKey,
              stage: 'provider',
              amountUsd: amount,
            });
          } else if (!closedRejectedAttempt) {
            await repository.markUnknownOutcome(execution.id, fence);
          }
        }
      }
      // Acquisition token prevents a delayed release from unlocking an ABA owner.
      await spend.updateOne(
        {
          idempotencyKey: LIVE_BUDGET_LEDGER_KEY,
          state: 'held',
          owner: gate.owner,
          gateToken: gate.gateToken ?? { $exists: false },
        },
        {
          $set: { state: 'free' },
          $unset: { owner: '', claimToken: '', gateToken: '' },
        },
      );
    },
    recordSpend,
    async getSpendTotal() {
      const rows = await spend
        .aggregate([
          { $match: { integration: 'live' } },
          {
            $group: {
              _id: null,
              total: { $sum: '$amountUsd' },
              unknown: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $isNumber: '$amountUsd' },
                        { $gte: ['$amountUsd', 0] },
                        { $lte: ['$amountUsd', Number.MAX_VALUE] },
                      ],
                    },
                    0,
                    1,
                  ],
                },
              },
            },
          },
        ])
        .toArray();
      const row = rows[0];
      if (!row) return 0;
      return row.unknown ||
        typeof row.total !== 'number' ||
        !Number.isFinite(row.total) ||
        row.total < 0
        ? null
        : row.total;
    },
  };
  return repository;
}
