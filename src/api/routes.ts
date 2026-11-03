import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Express, Request, Response } from 'express';
import type { Config } from '../config/index.js';
import {
  ApiExecutionListResponseSchema,
  ApiProviderStatusListResponseSchema,
  ApiProviderStatusSchema,
  ApiSetProviderKeyRequestSchema,
  ApiSubmitRequestSchema,
  CreateExecutionInputSchema,
  ProviderIdSchema,
  ExecutionStatusSchema,
  PROVIDER_LIVE_SUPPORT,
  utcRunDate,
  type ExecutionRepository,
  type ExecutionEnqueuer,
  type ProviderKeyResolver,
  type ProviderKeyStore,
} from '../contracts/index.js';
import { modelForProvider } from '../providers/index.js';
import { apiKeyAuth } from './auth.js';
import { toApiExecutionView } from './views.js';
import { registerExtractionRoutes } from './extraction-routes.js';
import type { ExtractionRepository } from '../db/extraction-repository.js';
import type { ExtractionService } from '../extraction/service.js';

export interface ApiDependencies {
  config: Config;
  repository: ExecutionRepository;
  enqueuer: ExecutionEnqueuer;
  resolver: ProviderKeyResolver;
  keyStore: ProviderKeyStore;
  clock?: () => number;
  extractions?: ExtractionRepository;
  extractionService?: ExtractionService;
}
class ApiFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const listQuery = z
  .object({
    provider: ProviderIdSchema.optional(),
    status: ExecutionStatusSchema.optional(),
    before: z.string().min(1).max(128).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiFailure(400, 'Invalid request');
  return parsed.data;
}
export function registerApiRoutes(app: Express, deps: ApiDependencies): void {
  const now = deps.clock ?? Date.now;
  const auth = apiKeyAuth(deps.config.OPERATOR_API_KEY);
  app.use(['/executions', '/providers', '/spend', '/visibility'], auth);
  if (deps.extractions && deps.extractionService)
    registerExtractionRoutes(app, {
      repository: deps.repository,
      extractions: deps.extractions,
      extractionService: deps.extractionService,
      clock: deps.clock,
    });
  const route =
    (handler: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response) => {
      try {
        await handler(req, res);
      } catch (error) {
        const safe =
          error instanceof ApiFailure
            ? error
            : new ApiFailure(503, 'Service unavailable');
        req.log.warn(
          { event: 'api.error', status: safe.status },
          'API request failed',
        );
        res
          .status(safe.status)
          .json({ error: safe.message, correlationId: req.correlationId });
      }
    };
  let sequence = 0;
  app.post(
    '/executions',
    route(async (req, res) => {
      const value = parse(ApiSubmitRequestSchema, req.body);
      const model = modelForProvider(deps.config, value.provider);
      sequence = Math.max(now(), sequence + 1);
      const input = CreateExecutionInputSchema.parse({
        questionId:
          value.questionId ??
          createHash('sha256')
            .update(value.questionText)
            .digest('hex')
            .slice(0, 32),
        questionText: value.questionText,
        questionVersion: 1,
        provider: value.provider,
        model,
        modelSettingsVersion: createHash('sha256')
          .update(JSON.stringify({ model, webSearch: value.webSearch }))
          .digest('hex')
          .slice(0, 16),
        runDate: utcRunDate(new Date(now())),
        runSeq: value.force ? sequence : 0,
        settings: { webSearch: value.webSearch },
      });
      const { execution, created } =
        await deps.repository.createQueuedIfAbsent(input);
      if (created || ['queued', 'retry_wait'].includes(execution.status)) {
        await deps.enqueuer.enqueue({
          executionId: execution.id,
          executionKey: execution.executionKey,
        });
      }
      // Keep the strict view body; creation semantics live in HTTP status/header, not an extra secret-prone envelope.
      res.setHeader('x-execution-created', String(created));
      res.status(created ? 201 : 200).json(toApiExecutionView(execution));
    }),
  );
  app.get(
    '/executions',
    route(async (req, res) => {
      const query = parse(listQuery, req.query);
      const items = await deps.repository.listRecent(query);
      res.json(
        ApiExecutionListResponseSchema.parse({
          items: items.map((item) => toApiExecutionView(item)),
          ...(items.length === query.limit
            ? { nextBefore: items.at(-1)?.id }
            : {}),
        }),
      );
    }),
  );
  app.get(
    '/executions/:id',
    route(async (req, res) => {
      const id = parse(z.string().min(1).max(128), req.params.id);
      const query = parse(
        z.object({ raw: z.literal('1').optional() }).strict(),
        req.query,
      );
      const execution = await deps.repository.getById(id);
      if (!execution) throw new ApiFailure(404, 'Execution not found');
      res.json(
        toApiExecutionView(
          execution,
          query.raw ? await deps.repository.getRawResponse(id) : undefined,
          deps.extractions
            ? (await deps.extractions.detail(id)).current
            : undefined,
        ),
      );
    }),
  );
  const status = async (provider: z.infer<typeof ProviderIdSchema>) => {
    const access = await deps.resolver.resolve(provider);
    const stored = await deps.keyStore.status(provider);
    return ApiProviderStatusSchema.parse({
      provider,
      liveSupported: PROVIDER_LIVE_SUPPORT[provider],
      mode: access.mode,
      keySource: access.keySource,
      ...(access.keySource === 'user' ? { expiresAt: stored.expiresAt } : {}),
    });
  };
  app.get(
    '/providers',
    route(async (_req, res) => {
      res.json(
        ApiProviderStatusListResponseSchema.parse({
          items: await Promise.all(ProviderIdSchema.options.map(status)),
        }),
      );
    }),
  );
  const writes = new Map<string, { count: number; resetAt: number }>();
  const checkKeyWrite = (req: Request) => {
    for (const [key, value] of writes)
      if (value.resetAt <= now()) writes.delete(key);
    const identity = req.ip ?? 'operator';
    const window = writes.get(identity) ?? {
      count: 0,
      resetAt: now() + 60_000,
    };
    window.count++;
    writes.set(identity, window);
    if (window.count > 10) throw new ApiFailure(429, 'Too many requests');
  };
  app.put(
    '/providers/:provider/key',
    route(async (req, res) => {
      checkKeyWrite(req);
      const provider = parse(ProviderIdSchema, req.params.provider);
      const value = parse(ApiSetProviderKeyRequestSchema, req.body);
      if (value.provider !== provider)
        throw new ApiFailure(400, 'Invalid request');
      await deps.keyStore.set(
        provider,
        value.apiKey,
        deps.config.USER_KEY_TTL_SECONDS,
      );
      res.json(await status(provider));
    }),
  );
  app.delete(
    '/providers/:provider/key',
    route(async (req, res) => {
      checkKeyWrite(req);
      const provider = parse(ProviderIdSchema, req.params.provider);
      if (!PROVIDER_LIVE_SUPPORT[provider])
        throw new ApiFailure(400, 'Provider is mock-only');
      await deps.keyStore.remove(provider);
      res.json(await status(provider));
    }),
  );
  app.get(
    '/spend',
    route(async (_req, res) => {
      const totalUsd = await deps.repository.getSpendTotal();
      res.json({
        totalUsd,
        capUsd: deps.config.SPEND_CAP_USD,
        remainingUsd:
          totalUsd === null
            ? null
            : Math.max(0, deps.config.SPEND_CAP_USD - totalUsd),
      });
    }),
  );
}
