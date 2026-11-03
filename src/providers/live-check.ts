import type {
  ProviderId,
  ProviderKeyResolver,
  ExecutionRepository,
} from '../contracts/index.js';

/** Called only by the opt-in CLI wired in worker.ts. It never prints raw output or credentials. */
export async function runLiveCheck(options: {
  provider: ProviderId;
  resolver: ProviderKeyResolver;
  repository: ExecutionRepository;
  runOnce: () => Promise<string>;
}): Promise<void> {
  if (process.env.ALLOW_LIVE !== '1')
    throw new Error('Live verification requires explicit opt-in');
  if ((await options.resolver.resolve(options.provider)).mode !== 'live')
    throw new Error('Live provider key is not configured');
  const id = await options.runOnce();
  const execution = await options.repository.getById(id);
  if (
    !execution ||
    execution.status !== 'succeeded' ||
    execution.integration !== 'live'
  )
    throw new Error('Live verification did not complete');
  const raw = await options.repository.getRawResponse(id);
  process.stdout.write(
    JSON.stringify({
      provider: execution.provider,
      model: execution.model,
      status: execution.status,
      latencyMs: execution.latencyMs,
      usage: execution.usage,
      estimatedCost: execution.cost,
      citationCount: raw?.citations.length ?? 0,
      domains: raw?.citations.map((c) => c.domain) ?? [],
    }) + '\n',
  );
}
