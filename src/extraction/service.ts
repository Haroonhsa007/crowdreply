import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { ExecutionRepository } from '../contracts/index.js';
import type { ExtractionJobPayload } from '../contracts/extraction.js';
import {
  publicExtraction,
  type ExtractionRepository,
} from '../db/extraction-repository.js';
import { ReprocessExtractionRequestSchema } from '../contracts/extraction-api.js';
export interface ExtractionEnqueuer {
  enqueue(payload: ExtractionJobPayload): Promise<void>;
}
export class ExtractionRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
/** A late enqueue remains safe because Mongo authority and queue job IDs are stable. */
export async function enqueueWithDeadline(
  enqueue: () => Promise<void>,
  timeoutMs = 2500,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(enqueue),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Queue enqueue deadline exceeded')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function createExtractionService(deps: {
  repository: ExecutionRepository;
  extractions: ExtractionRepository;
  enqueuer: ExtractionEnqueuer;
  logger: Logger;
}) {
  const dispatch = async (payload: ExtractionJobPayload) => {
    try {
      await enqueueWithDeadline(() => deps.enqueuer.enqueue(payload));
      await deps.extractions.touch(payload);
    } catch {
      deps.logger.warn(
        { stage: 'extraction.enqueue_deferred' },
        'Durable extraction awaits queue recovery',
      );
    }
  };
  const initial = async (executionId: string) => {
    const execution = await deps.repository.getById(executionId);
    if (!execution || execution.status !== 'succeeded') return;
    const requested = await deps.extractions.request(execution);
    if (['pending', 'extracting'].includes(requested.extraction.status))
      await dispatch({
        executionId,
        extractorVersion: requested.extraction.extractorVersion,
      });
  };
  const reprocess = async (executionId: string, input: unknown) => {
    const parsed = ReprocessExtractionRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new ExtractionRequestError(400, 'Invalid reprocess request');
    const execution = await deps.repository.getById(executionId);
    if (!execution)
      throw new ExtractionRequestError(404, 'Execution not found');
    if (execution.status !== 'succeeded')
      throw new ExtractionRequestError(
        409,
        'Extraction requires a successful execution',
      );
    const extractorVersion =
      'rules-v1-reprocess-' +
      createHash('sha256').update(parsed.data.idempotencyKey).digest('hex');
    const existing = await deps.extractions.byVersion({
      executionId,
      extractorVersion,
    });
    if (existing) {
      await deps.extractions.syncCurrent(executionId);
      return { extraction: publicExtraction(existing), created: false };
    }
    if (!(await deps.repository.getRawResponse(executionId)))
      throw new ExtractionRequestError(
        410,
        'The stored raw response is no longer available for reprocessing',
      );
    const requested = await deps.extractions.request(
      execution,
      extractorVersion,
    );
    await dispatch({ executionId, extractorVersion });
    return requested;
  };
  return { initial, reprocess, dispatch };
}
export type ExtractionService = ReturnType<typeof createExtractionService>;
