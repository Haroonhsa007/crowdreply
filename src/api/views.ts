import type { Extraction } from '../contracts/extraction.js';
import {
  ApiExecutionViewSchema,
  type Execution,
  type ApiExecutionView,
  type RawResponse,
} from '../contracts/index.js';

export function toApiExecutionView(
  execution: Execution,
  raw?: RawResponse | null,
  extraction?: Extraction | null,
): ApiExecutionView {
  return ApiExecutionViewSchema.parse({
    id: execution.id,
    executionKey: execution.executionKey,
    questionText: execution.questionText,
    provider: execution.provider,
    integration: execution.integration,
    model: execution.model,
    status: execution.status,
    extractionStatus: execution.extractionStatus,
    citationsAvailable: execution.citationsAvailable,
    attemptCount: execution.attempts.length,
    retryAt: execution.retryAt,
    lastErrorCategory: execution.lastErrorCategory,
    latencyMs: execution.latencyMs,
    usage: execution.usage,
    cost: execution.cost,
    createdAt: execution.createdAt,
    completedAt: execution.completedAt,
    ...(extraction
      ? {
          extraction: {
            id: extraction.id,
            extractorVersion: extraction.extractorVersion,
            method: extraction.method,
            status: extraction.status,
            mentionCount: extraction.mentions.reduce(
              (total, mention) => total + mention.mentionCount,
              0,
            ),
            createdAt: extraction.createdAt,
          },
        }
      : {}),
    ...(raw
      ? {
          raw: {
            outputText: raw.outputText,
            citations: raw.citations,
            providerResponseId: raw.providerResponseId,
          },
        }
      : {}),
  });
}
