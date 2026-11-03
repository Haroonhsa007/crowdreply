import type { ExtractionRepository } from '../db/extraction-repository.js';
import type { ExtractionService } from '../extraction/service.js';
export async function recoverExtractions(
  repository: ExtractionRepository,
  service: ExtractionService,
  limit = 100,
): Promise<void> {
  for (const id of await repository.pendingExecutions(limit))
    await service.initial(id);
  for (const payload of await repository.recover(limit))
    await service.dispatch(payload);
}
