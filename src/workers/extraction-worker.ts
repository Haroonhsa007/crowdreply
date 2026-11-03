import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { ExecutionRepository } from '../contracts/index.js';
import {
  ExtractionJobPayloadSchema,
  type ExtractionJobPayload,
} from '../contracts/extraction.js';
import type { ExtractionRepository } from '../db/extraction-repository.js';
import { extractRuleBased } from '../extraction/rule-based.js';
export interface ExtractionWorkerDependencies {
  repository: ExecutionRepository;
  extractions: ExtractionRepository;
  logger: Logger;
  extract?: typeof extractRuleBased;
}
export async function processExtraction(
  value: ExtractionJobPayload,
  deps: ExtractionWorkerDependencies,
): Promise<void> {
  const payload = ExtractionJobPayloadSchema.parse(value);
  const claim = await deps.extractions.claim(payload);
  if (!claim) return;
  try {
    const raw = await deps.repository.getRawResponse(payload.executionId);
    if (!raw) {
      await deps.extractions.fail(claim, 'raw_unavailable', true);
      return;
    }
    const extracted = (deps.extract ?? extractRuleBased)({
      executionId: claim.executionId,
      provider: claim.provider,
      integration: claim.integration,
      runDate: claim.runDate,
      raw,
      id: claim.id,
      extractorVersion: claim.extractorVersion,
      createdAt: claim.createdAt,
    });
    await deps.extractions.complete(claim, extracted);
  } catch {
    await deps.extractions.fail(claim, 'extraction_error');
    deps.logger.warn(
      { stage: 'extraction.failed' },
      'Extraction needs retry or operator attention',
    );
  }
}
export function createExtractionWorker(
  connection: Redis,
  deps: ExtractionWorkerDependencies,
) {
  const worker = new Worker<ExtractionJobPayload>(
    'extraction',
    (job) => processExtraction(job.data, deps),
    { connection, concurrency: 1 },
  );
  worker.on('error', () =>
    deps.logger.error(
      { stage: 'extraction.worker_error' },
      'Extraction worker needs attention',
    ),
  );
  return { isRunning: () => worker.isRunning(), close: () => worker.close() };
}
