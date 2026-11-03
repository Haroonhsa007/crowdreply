import { createHash, randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { z } from 'zod';
import type { Execution, ProviderId } from '../contracts/index.js';
import {
  ExtractionSchema,
  type Extraction,
  type ExtractionJobPayload,
} from '../contracts/extraction.js';
import {
  VisibilityResponseSchema,
  VISIBILITY_SHARE_DEFINITION,
  type VisibilityResponse,
} from '../contracts/extraction-api.js';
import { BRAND_ALIASES } from '../extraction/aliases.js';
import { RULE_BASED_VERSION } from '../extraction/rule-based.js';
import type { CollectionPort, Row } from './execution-repository.js';

export const INITIAL_EXTRACTION_VERSION = 'rules-v1-initial';
const MAX_EXTRACTION_ATTEMPTS = 3;
const WorkSchema = ExtractionSchema.extend({
  revision: z.number().int().nonnegative(),
  attemptCount: z.number().int().nonnegative(),
  claimToken: z.string().optional(),
  leaseUntil: z.string().datetime().optional(),
  retryAt: z.string().datetime().optional(),
  completedToken: z.string().optional(),
  lastRecoveryTouch: z.string().datetime().optional(),
});
export type ExtractionWork = z.infer<typeof WorkSchema>;
export interface ExtractionStorage {
  executions: CollectionPort;
  extractions: CollectionPort;
  mentions: CollectionPort;
  aliases: CollectionPort;
}
export function mongoExtractionStorage(db: Db): ExtractionStorage {
  return {
    executions: db.collection<Row>('executions'),
    extractions: db.collection<Row>('extractions'),
    mentions: db.collection<Row>('brand_mentions'),
    aliases: db.collection<Row>('brand_aliases'),
  };
}
const parseWork = (row: Row): ExtractionWork => {
  const { _id, ...value } = row;
  void _id;
  return WorkSchema.parse(value);
};
export function publicExtraction(work: ExtractionWork): Extraction {
  const {
    revision,
    attemptCount,
    claimToken,
    leaseUntil,
    retryAt,
    completedToken,
    lastRecoveryTouch,
    ...value
  } = work;
  void revision;
  void attemptCount;
  void claimToken;
  void leaseUntil;
  void retryAt;
  void completedToken;
  void lastRecoveryTouch;
  return ExtractionSchema.parse(value);
}
const duplicate = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 11000;
export interface VisibilityQuery {
  from: string;
  to: string;
  includeMock: boolean;
  provider?: ProviderId;
}

export function createExtractionRepository(
  storage: ExtractionStorage,
  clock: () => Date = () => new Date(),
) {
  const now = () => clock().toISOString();
  const byVersion = async (payload: ExtractionJobPayload) => {
    const row = await storage.extractions.findOne(payload);
    return row ? parseWork(row) : null;
  };
  const getById = async (id: string) => {
    const row = await storage.extractions.findOne({ id });
    return row ? parseWork(row) : null;
  };
  // Compare-and-set prevents an older recovery/completion from replacing a newer request.
  const syncCurrent = async (executionId: string): Promise<void> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const execution = await storage.executions.findOne({
        id: executionId,
        status: 'succeeded',
      });
      if (!execution) return;
      const latest = (
        await storage.extractions
          .find({ executionId })
          .sort({ revision: -1, id: -1 })
          .limit(1)
          .toArray()
      )[0];
      if (!latest) return;
      const current = parseWork(latest);
      const result = await storage.executions.updateOne(
        {
          id: executionId,
          status: 'succeeded',
          extractionId: execution.extractionId ?? { $exists: false },
          extractionStatus: execution.extractionStatus,
        },
        {
          $set: { extractionId: current.id, extractionStatus: current.status },
        },
      );
      if (result.matchedCount) return;
    }
    throw new Error('Extraction pointer reconciliation conflicted');
  };
  const request = async (
    execution: Execution,
    extractorVersion = INITIAL_EXTRACTION_VERSION,
  ) => {
    const identity = { executionId: execution.id, extractorVersion };
    let existing = await byVersion(identity);
    let created = false;
    if (!existing) {
      if (execution.status !== 'succeeded' || !execution.integration)
        throw new Error('Extraction requires a successful execution');
      let revision = 0;
      if (extractorVersion !== INITIAL_EXTRACTION_VERSION) {
        const row = await storage.executions.findOneAndUpdate(
          { id: execution.id, status: 'succeeded' },
          { $inc: { extractionRevision: 1 } },
          { returnDocument: 'after' },
        );
        if (!row || typeof row.extractionRevision !== 'number')
          throw new Error('Execution no longer available');
        revision = row.extractionRevision;
      }
      const work: ExtractionWork = {
        id: createHash('sha256')
          .update(JSON.stringify([execution.id, extractorVersion]))
          .digest('hex'),
        ...identity,
        algorithmVersion: RULE_BASED_VERSION,
        method: 'rule_based',
        status: 'pending',
        provider: execution.provider,
        integration: execution.integration,
        runDate: execution.runDate,
        createdAt: now(),
        mentions: [],
        citedDomains: [],
        revision,
        attemptCount: 0,
      };
      try {
        await storage.extractions.insertOne({ ...work });
        existing = work;
        created = true;
      } catch (error) {
        if (!duplicate(error)) throw error;
        existing = await byVersion(identity);
        if (!existing) throw error;
      }
    }
    await syncCurrent(execution.id);
    return { extraction: publicExtraction(existing), created };
  };
  const claim = async (
    payload: ExtractionJobPayload,
    leaseMs = 30_000,
  ): Promise<ExtractionWork | null> => {
    const row = await storage.extractions.findOneAndUpdate(
      {
        ...payload,
        attemptCount: { $lt: MAX_EXTRACTION_ATTEMPTS },
        $or: [
          { status: 'pending', retryAt: { $exists: false } },
          { status: 'pending', retryAt: { $lte: now() } },
          { status: 'extracting', leaseUntil: { $lte: now() } },
        ],
      },
      {
        $set: {
          status: 'extracting',
          claimToken: randomUUID(),
          leaseUntil: new Date(clock().getTime() + leaseMs).toISOString(),
        },
        $inc: { attemptCount: 1 },
        $unset: { retryAt: '', error: '' },
      },
      { returnDocument: 'after' },
    );
    if (!row) return null;
    await syncCurrent(payload.executionId);
    return parseWork(row);
  };
  const fence = (work: ExtractionWork): Row => ({
    id: work.id,
    status: 'extracting',
    claimToken: work.claimToken,
    leaseUntil: { $gt: now() },
  });
  const complete = async (
    work: ExtractionWork,
    value: Extraction,
  ): Promise<boolean> => {
    if (!work.claimToken) throw new Error('Extraction claim required');
    const result = ExtractionSchema.parse(value);
    if (
      result.id !== work.id ||
      result.executionId !== work.executionId ||
      result.extractorVersion !== work.extractorVersion ||
      result.algorithmVersion !== work.algorithmVersion ||
      result.provider !== work.provider ||
      result.integration !== work.integration ||
      result.runDate !== work.runDate ||
      result.createdAt !== work.createdAt ||
      result.status !== 'extracted'
    )
      throw new Error('Extraction result identity mismatch');
    // Staged attempt rows cannot become visible unless the fenced version publishes this token.
    for (const [ordinal, mention] of result.mentions.entries())
      await storage.mentions.updateOne(
        { extractionId: work.id, claimToken: work.claimToken, ordinal },
        {
          $setOnInsert: {
            ...mention,
            executionId: work.executionId,
            provider: work.provider,
            integration: work.integration,
            runDate: work.runDate,
          },
        },
        { upsert: true },
      );
    const updated = await storage.extractions.updateOne(fence(work), {
      $set: { ...result, completedAt: now(), completedToken: work.claimToken },
      $unset: { claimToken: '', leaseUntil: '', retryAt: '', error: '' },
    });
    await syncCurrent(work.executionId);
    return updated.matchedCount === 1;
  };
  const fail = async (
    work: ExtractionWork,
    code: 'raw_unavailable' | 'extraction_error',
    terminal = false,
  ): Promise<boolean> => {
    const exhausted = terminal || work.attemptCount >= MAX_EXTRACTION_ATTEMPTS;
    const updated = await storage.extractions.updateOne(fence(work), {
      $set: {
        status: exhausted ? 'extraction_failed' : 'pending',
        error: {
          code,
          message:
            code === 'raw_unavailable'
              ? 'The stored raw response is no longer available for extraction.'
              : 'Extraction could not be completed.',
        },
        ...(exhausted
          ? { completedAt: now() }
          : {
              retryAt: new Date(
                clock().getTime() + 1000 * 2 ** (work.attemptCount - 1),
              ).toISOString(),
            }),
      },
      $unset: { claimToken: '', leaseUntil: '' },
    });
    await syncCurrent(work.executionId);
    return updated.matchedCount === 1;
  };
  const recover = async (limit = 100): Promise<ExtractionJobPayload[]> => {
    const expired = await storage.extractions
      .find({
        status: 'extracting',
        leaseUntil: { $lte: now() },
        attemptCount: { $gte: MAX_EXTRACTION_ATTEMPTS },
      })
      .sort({ leaseUntil: 1, id: 1 })
      .limit(limit)
      .toArray();
    for (const row of expired) {
      await storage.extractions.updateOne(
        {
          id: row.id,
          status: 'extracting',
          claimToken: row.claimToken,
          leaseUntil: { $lte: now() },
        },
        {
          $set: {
            status: 'extraction_failed',
            completedAt: now(),
            error: {
              code: 'attempts_exhausted',
              message: 'Extraction exhausted its bounded processing attempts.',
            },
          },
          $unset: { claimToken: '', leaseUntil: '' },
        },
      );
      await syncCurrent(String(row.executionId));
    }
    const rows = await storage.extractions
      .find({
        $or: [
          { status: 'pending', retryAt: { $exists: false } },
          { status: 'pending', retryAt: { $lte: now() } },
          {
            status: 'extracting',
            leaseUntil: { $lte: now() },
            attemptCount: { $lt: MAX_EXTRACTION_ATTEMPTS },
          },
        ],
      })
      .sort({ lastRecoveryTouch: 1, createdAt: 1, id: 1 })
      .limit(limit)
      .toArray();
    const repair = await storage.executions
      .find({
        status: 'succeeded',
        extractionStatus: { $in: ['pending', 'extracting'] },
        extractionId: { $exists: true },
      })
      .sort({ extractionRepairTouch: 1, createdAt: 1, id: 1 })
      .limit(limit)
      .toArray();
    for (const row of rows) await syncCurrent(String(row.executionId));
    for (const row of repair) {
      await syncCurrent(String(row.id));
      await storage.executions.updateOne(
        { id: row.id },
        { $set: { extractionRepairTouch: now() } },
      );
    }
    return rows.map((row) => ({
      executionId: String(row.executionId),
      extractorVersion: String(row.extractorVersion),
    }));
  };
  const pendingExecutions = async (limit = 100): Promise<string[]> =>
    (
      await storage.executions
        .find({
          status: 'succeeded',
          extractionStatus: 'pending',
          extractionId: { $exists: false },
        })
        .sort({ createdAt: 1, id: 1 })
        .limit(limit)
        .toArray()
    ).map((row) => String(row.id));
  const detail = async (executionId: string) => {
    const execution = await storage.executions.findOne({ id: executionId });
    const current =
      typeof execution?.extractionId === 'string'
        ? await getById(execution.extractionId)
        : null;
    const history = await storage.extractions
      .find({ executionId })
      .sort({ revision: -1, id: -1 })
      .limit(20)
      .toArray();
    return {
      current: current ? publicExtraction(current) : null,
      history: history.map((row) => publicExtraction(parseWork(row))),
      historyLimit: 20 as const,
    };
  };
  const seedAliases = async () => {
    for (const item of BRAND_ALIASES)
      for (const alias of item.aliases)
        await storage.aliases.updateOne(
          { alias },
          { $setOnInsert: { brand: item.brand, domains: [...item.domains] } },
          { upsert: true },
        );
  };
  const visibility = async (
    query: VisibilityQuery,
  ): Promise<VisibilityResponse> => {
    const rows = await storage.extractions
      .aggregate([
        {
          $match: {
            status: 'extracted',
            runDate: { $gte: query.from, $lte: query.to },
            ...(query.provider ? { provider: query.provider } : {}),
            ...(!query.includeMock ? { integration: 'live' } : {}),
          },
        },
        {
          $lookup: {
            from: 'executions',
            localField: 'executionId',
            foreignField: 'id',
            as: 'execution',
          },
        },
        { $unwind: '$execution' },
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ['$execution.extractionId', '$id'] },
                { $eq: ['$execution.status', 'succeeded'] },
              ],
            },
          },
        },
        {
          $facet: {
            counts: [{ $group: { _id: '$integration', count: { $sum: 1 } } }],
            items: [
              { $unwind: '$mentions' },
              { $match: { 'mentions.ambiguous': false } },
              {
                $group: {
                  _id: {
                    provider: '$provider',
                    integration: '$integration',
                    brand: '$mentions.brand',
                  },
                  mentionCount: { $sum: '$mentions.mentionCount' },
                  averagePosition: { $avg: '$mentions.position' },
                },
              },
              {
                $setWindowFields: {
                  partitionBy: {
                    provider: '$_id.provider',
                    integration: '$_id.integration',
                  },
                  output: {
                    eligibleMentions: {
                      $sum: '$mentionCount',
                      window: { documents: ['unbounded', 'unbounded'] },
                    },
                  },
                },
              },
              {
                $project: {
                  _id: 0,
                  provider: '$_id.provider',
                  integration: '$_id.integration',
                  brand: '$_id.brand',
                  mentionCount: 1,
                  averagePosition: 1,
                  share: { $divide: ['$mentionCount', '$eligibleMentions'] },
                },
              },
              {
                $sort: {
                  provider: 1,
                  integration: 1,
                  mentionCount: -1,
                  brand: 1,
                },
              },
              { $limit: 1001 },
            ],
          },
        },
      ])
      .toArray();
    const aggregate = z
      .object({
        counts: z.array(
          z.object({
            _id: z.enum(['live', 'mock']),
            count: z.number().int().nonnegative(),
          }),
        ),
        items: z.array(z.unknown()),
      })
      .parse(rows[0] ?? { counts: [], items: [] });
    const live = aggregate.counts.find((row) => row._id === 'live')?.count ?? 0;
    const mock = aggregate.counts.find((row) => row._id === 'mock')?.count ?? 0;
    return VisibilityResponseSchema.parse({
      from: query.from,
      to: query.to,
      includeMock: query.includeMock,
      includesMock: mock > 0,
      executionCounts: { live, mock },
      items: aggregate.items.slice(0, 1000),
      truncated: aggregate.items.length > 1000,
      shareDefinition: VISIBILITY_SHARE_DEFINITION,
    });
  };
  const touch = async (payload: ExtractionJobPayload) => {
    await storage.extractions.updateOne(payload, {
      $set: { lastRecoveryTouch: now() },
    });
  };
  return {
    touch,
    request,
    byVersion,
    getById,
    syncCurrent,
    claim,
    complete,
    fail,
    recover,
    pendingExecutions,
    detail,
    seedAliases,
    visibility,
  };
}
export type ExtractionRepository = ReturnType<
  typeof createExtractionRepository
>;
