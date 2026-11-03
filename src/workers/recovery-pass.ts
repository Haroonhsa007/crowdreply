import type { Logger } from 'pino';
/** Independent phases preserve extraction progress even when provider recovery fails. */
export async function runRecoveryPass(
  phases: { provider(): Promise<unknown>; extraction(): Promise<unknown> },
  logger: Logger,
): Promise<boolean> {
  const results = await Promise.allSettled([
    Promise.resolve().then(phases.provider),
    Promise.resolve().then(phases.extraction),
  ]);
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected')
      logger.error(
        {
          stage:
            index === 0
              ? 'provider.recovery_failed'
              : 'extraction.recovery_failed',
        },
        index === 0
          ? 'Provider recovery needs attention'
          : 'Extraction recovery needs attention',
      );
  }
  return results.every((result) => result.status === 'fulfilled');
}
