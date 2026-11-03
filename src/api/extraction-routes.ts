import { z } from 'zod';
import type { Express, Request, Response } from 'express';
import {
  ProviderIdSchema,
  type ExecutionRepository,
} from '../contracts/index.js';
import {
  ExtractionDetailSchema,
  ReprocessExtractionResponseSchema,
} from '../contracts/extraction-api.js';
import type { ExtractionRepository } from '../db/extraction-repository.js';
import {
  ExtractionRequestError,
  type ExtractionService,
} from '../extraction/service.js';
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  });
export function registerExtractionRoutes(
  app: Express,
  deps: {
    repository: ExecutionRepository;
    extractions: ExtractionRepository;
    extractionService: ExtractionService;
    clock?: () => number;
  },
) {
  const route =
    (handler: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response) => {
      try {
        await handler(req, res);
      } catch (error) {
        const safe =
          error instanceof ExtractionRequestError
            ? error
            : new ExtractionRequestError(503, 'Extraction service unavailable');
        req.log.warn(
          { event: 'extraction.api_error', status: safe.status },
          'Extraction API request failed',
        );
        res
          .status(safe.status)
          .json({ error: safe.message, correlationId: req.correlationId });
      }
    };
  const executionId = (value: unknown) => {
    const parsed = z.string().min(1).max(128).safeParse(value);
    if (!parsed.success)
      throw new ExtractionRequestError(400, 'Invalid execution identifier');
    return parsed.data;
  };
  app.get(
    '/executions/:id/extraction',
    route(async (req, res) => {
      const id = executionId(req.params.id);
      if (!(await deps.repository.getById(id)))
        throw new ExtractionRequestError(404, 'Execution not found');
      if (Object.keys(req.query).length)
        throw new ExtractionRequestError(400, 'Invalid query');
      res.json(ExtractionDetailSchema.parse(await deps.extractions.detail(id)));
    }),
  );
  app.post(
    '/executions/:id/extraction/reprocess',
    route(async (req, res) => {
      if (Object.keys(req.query).length)
        throw new ExtractionRequestError(400, 'Invalid query');
      const result = await deps.extractionService.reprocess(
        executionId(req.params.id),
        req.body,
      );
      res
        .status(result.created ? 202 : 200)
        .json(ReprocessExtractionResponseSchema.parse(result));
    }),
  );
  app.get(
    '/visibility',
    route(async (req, res) => {
      const today = new Date(deps.clock?.() ?? Date.now())
        .toISOString()
        .slice(0, 10);
      const from = new Date(
        new Date(`${today}T00:00:00.000Z`).getTime() - 29 * 86400_000,
      )
        .toISOString()
        .slice(0, 10);
      const query = z
        .object({
          from: date.default(from),
          to: date.default(today),
          provider: ProviderIdSchema.optional(),
          includeMock: z
            .enum(['true', 'false'])
            .default('false')
            .transform((value) => value === 'true'),
        })
        .strict()
        .refine(
          (value) =>
            value.from <= value.to &&
            Date.parse(value.to) - Date.parse(value.from) <= 365 * 86400_000,
        )
        .safeParse(req.query);
      if (!query.success)
        throw new ExtractionRequestError(
          400,
          'Invalid visibility query; use UTC dates spanning at most 366 days',
        );
      res.json(await deps.extractions.visibility(query.data));
    }),
  );
}
