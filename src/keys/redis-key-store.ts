import { z } from 'zod';
import {
  ApiSetProviderKeyRequestSchema,
  USER_KEY_TTL_SECONDS_MAX,
  type ProviderId,
  type ProviderKeyStore,
} from '../contracts/index.js';
import { keyCipher } from './crypto.js';

export interface KeyRedis {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    expiry: 'EX',
    seconds: number,
  ): Promise<unknown>;
  del(key: string): Promise<unknown>;
}
const recordSchema = z
  .object({ blob: z.string(), expiresAt: z.string().datetime() })
  .strict();
export function createKeyStore(
  redis: KeyRedis,
  secret: string,
  clock: () => number = Date.now,
): ProviderKeyStore {
  const cipher = keyCipher(secret);
  const redisKey = (provider: ProviderId) => `providerkey:${provider}`;
  const read = async (provider: ProviderId) => {
    const text = await redis.get(redisKey(provider));
    if (!text) return null;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    const record = recordSchema.safeParse(value);
    if (!record.success) return null;
    if (Date.parse(record.data.expiresAt) <= clock()) {
      // Redis owns expiry. A GET snapshot can race a replacement SET, so an
      // unconditional DEL here could erase a newly supplied credential.
      return null;
    }
    const key = cipher.decrypt(record.data.blob);
    return key ? { key, expiresAt: record.data.expiresAt } : null;
  };
  return {
    async set(provider, apiKey, ttlSeconds) {
      if (
        !ApiSetProviderKeyRequestSchema.safeParse({ provider, apiKey }).success
      )
        throw new Error('Invalid provider key');
      if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0)
        throw new Error('Invalid key lifetime');
      const ttl = Math.min(ttlSeconds, USER_KEY_TTL_SECONDS_MAX);
      const expiresAt = new Date(clock() + ttl * 1000).toISOString();
      await redis.set(
        redisKey(provider),
        JSON.stringify({ blob: cipher.encrypt(apiKey), expiresAt }),
        'EX',
        ttl,
      );
      return { expiresAt };
    },
    async getDecrypted(provider) {
      if (provider === 'google_ai') return null;
      return (await read(provider))?.key ?? null;
    },
    async status(provider) {
      const record = provider === 'google_ai' ? null : await read(provider);
      return record
        ? {
            provider,
            configured: true,
            source: 'user',
            expiresAt: record.expiresAt,
          }
        : { provider, configured: false, source: 'none' };
    },
    async remove(provider) {
      await redis.del(redisKey(provider));
    },
  };
}
