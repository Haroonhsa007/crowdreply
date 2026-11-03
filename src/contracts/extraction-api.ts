import { z } from 'zod';
import { ProviderIdSchema, ProviderModeSchema } from './index.ts';
import { ExtractionSchema } from './extraction.ts';

export const ExtractionDetailSchema = z
  .object({
    current: ExtractionSchema.nullable(),
    history: z.array(ExtractionSchema).max(20),
    historyLimit: z.literal(20),
  })
  .strict();
export type ExtractionDetail = z.infer<typeof ExtractionDetailSchema>;
export const ReprocessExtractionRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(128),
  })
  .strict();
export const ReprocessExtractionResponseSchema = z
  .object({
    extraction: ExtractionSchema,
    created: z.boolean(),
  })
  .strict();
export const VisibilityItemSchema = z
  .object({
    provider: ProviderIdSchema,
    integration: ProviderModeSchema,
    brand: z.string().min(1),
    mentionCount: z.number().int().positive(),
    averagePosition: z.number().positive().nullable(),
    share: z.number().min(0).max(1),
  })
  .strict();
export const VISIBILITY_SHARE_DEFINITION =
  'Eligible unambiguous brand mention count divided by all eligible brand mentions for the same provider and integration; this is not a performance score.';
export const VisibilityResponseSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    includeMock: z.boolean(),
    includesMock: z.boolean(),
    executionCounts: z
      .object({
        live: z.number().int().nonnegative(),
        mock: z.number().int().nonnegative(),
      })
      .strict(),
    items: z.array(VisibilityItemSchema).max(1000),
    truncated: z.boolean(),
    shareDefinition: z.literal(VISIBILITY_SHARE_DEFINITION),
  })
  .strict();
export type VisibilityResponse = z.infer<typeof VisibilityResponseSchema>;
