import { z } from 'zod';
import {
  ExtractionStatusSchema,
  ProviderIdSchema,
  ProviderModeSchema,
} from './index.ts';

const nonempty = z.string().trim().min(1);
const timestamp = z.string().datetime();
export const SourceSpanSchema = z
  .object({
    startIndex: z.number().int().nonnegative(),
    endIndex: z.number().int().nonnegative(),
    text: z.string(),
  })
  .strict()
  .refine(
    (span) =>
      span.endIndex >= span.startIndex &&
      span.endIndex - span.startIndex === span.text.length,
    'Expected a UTF-16 source span',
  );
export const BrandMentionSchema = z
  .object({
    brand: nonempty,
    alias: nonempty,
    position: z.number().int().positive().nullable(),
    mentionCount: z.number().int().positive(),
    ambiguous: z.boolean(),
    ambiguityReason: nonempty.nullable(),
    sourceSpan: SourceSpanSchema,
    confidence: z.number().finite().min(0).max(1),
    citationIndexes: z.array(z.number().int().nonnegative()),
  })
  .strict()
  .refine(
    (mention) => !mention.ambiguous || mention.ambiguityReason !== null,
    'Ambiguous mentions require a reason',
  );
export type BrandMention = z.infer<typeof BrandMentionSchema>;
export type SourceSpan = z.infer<typeof SourceSpanSchema>;
export const ExtractionSchema = z
  .object({
    id: nonempty,
    executionId: nonempty,
    extractorVersion: nonempty,
    algorithmVersion: nonempty,
    method: z.enum(['rule_based', 'llm']),
    status: ExtractionStatusSchema,
    provider: ProviderIdSchema,
    integration: ProviderModeSchema,
    runDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((value) => {
        const date = new Date(`${value}T00:00:00.000Z`);
        return (
          Number.isFinite(date.getTime()) &&
          date.toISOString().slice(0, 10) === value
        );
      }),
    createdAt: timestamp,
    completedAt: timestamp.optional(),
    mentions: z.array(BrandMentionSchema),
    citedDomains: z.array(nonempty),
    error: z.object({ code: nonempty, message: nonempty }).strict().optional(),
  })
  .strict();
export type Extraction = z.infer<typeof ExtractionSchema>;
export const ExtractionJobPayloadSchema = z
  .object({ executionId: nonempty, extractorVersion: nonempty })
  .strict();
export type ExtractionJobPayload = z.infer<typeof ExtractionJobPayloadSchema>;
