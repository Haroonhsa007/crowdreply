import type { Config } from '../config/index.js';
import {
  PROVIDER_LIVE_SUPPORT,
  type ProviderId,
  type ProviderKeyResolver,
  type ProviderKeyStore,
} from '../contracts/index.js';

export function createKeyResolver(
  store: ProviderKeyStore,
  config: Config,
): ProviderKeyResolver {
  const configured: Record<ProviderId, string | undefined> = {
    openai: config.OPENAI_API_KEY,
    perplexity: config.PERPLEXITY_API_KEY,
    gemini: config.GEMINI_API_KEY,
    anthropic: config.ANTHROPIC_API_KEY,
    google_ai: undefined,
  };
  return {
    async resolve(provider) {
      if (!PROVIDER_LIVE_SUPPORT[provider])
        return { provider, mode: 'mock', keySource: 'none' };
      const userKey = await store.getDecrypted(provider);
      if (userKey)
        return { provider, mode: 'live', keySource: 'user', apiKey: userKey };
      const apiKey = configured[provider];
      return apiKey
        ? { provider, mode: 'live', keySource: 'env', apiKey }
        : { provider, mode: 'mock', keySource: 'none' };
    },
  };
}
