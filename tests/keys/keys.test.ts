import { FakeRedis } from './fake-redis.js';
import { describe, expect, it, vi } from 'vitest';
import { keyCipher } from '../../src/keys/crypto.js';
import { createKeyStore } from '../../src/keys/redis-key-store.js';
import { createKeyResolver } from '../../src/keys/key-resolver.js';
import { loadConfig } from '../../src/config/index.js';
import { foundationEnv } from '../foundation/fixtures.js';

describe('encrypted provider keys', () => {
  it('round trips with randomized IVs and rejects tampering', () => {
    const cipher = keyCipher(foundationEnv.KEY_ENCRYPTION_SECRET);
    const a = cipher.encrypt('placeholder-user-provider-key');
    const b = cipher.encrypt('placeholder-user-provider-key');
    expect(a).not.toBe(b);
    expect(a).not.toContain('placeholder-user-provider-key');
    expect(cipher.decrypt(a)).toBe('placeholder-user-provider-key');
    expect(cipher.decrypt(a.slice(0, -4) + 'aaaa')).toBeNull();
  });
  it('clamps TTL, overwrites, expires, removes, and never returns keys in status', async () => {
    let now = Date.parse('2026-11-02T00:00:00Z');
    const redis = new FakeRedis(() => now);
    const store = createKeyStore(
      redis,
      foundationEnv.KEY_ENCRYPTION_SECRET,
      () => now,
    );
    await store.set('openai', 'placeholder-user-provider-key', 9000);
    expect(redis.values.get('providerkey:openai')?.until).toBe(now + 3600000);
    expect(JSON.stringify(await store.status('openai'))).not.toContain(
      'placeholder-user-provider-key',
    );
    now += 1000;
    await store.set('openai', 'placeholder-replacement-key', 3600);
    expect(await store.getDecrypted('openai')).toBe(
      'placeholder-replacement-key',
    );
    const resolver = createKeyResolver(
      store,
      loadConfig({
        ...foundationEnv,
        OPENAI_API_KEY: 'placeholder-env-provider-key',
      }),
    );
    expect((await resolver.resolve('openai')).keySource).toBe('user');
    now += 3600001;
    expect((await resolver.resolve('openai')).keySource).toBe('env');
    expect(
      (
        await createKeyResolver(store, loadConfig(foundationEnv)).resolve(
          'openai',
        )
      ).mode,
    ).toBe('mock');
    await store.remove('openai');
    expect((await store.status('openai')).configured).toBe(false);
    expect((await resolver.resolve('google_ai')).mode).toBe('mock');
  });
  it('does not delete a replacement key during an expired snapshot read', async () => {
    let now = Date.parse('2026-11-02T00:00:00Z');
    const redis = new FakeRedis(() => now);
    const store = createKeyStore(
      redis,
      foundationEnv.KEY_ENCRYPTION_SECRET,
      () => now,
    );
    await store.set('openai', 'placeholder-expired-key', 1);
    const expired = redis.values.get('providerkey:openai')!.value;
    now += 1001;
    vi.spyOn(redis, 'get').mockImplementationOnce(async () => {
      await store.set('openai', 'placeholder-replacement-survives', 3600);
      return expired;
    });
    expect(await store.getDecrypted('openai')).toBeNull();
    expect(await store.getDecrypted('openai')).toBe(
      'placeholder-replacement-survives',
    );
  });
  it('rejects unsupported providers, invalid lifetimes and header-injection values', async () => {
    const store = createKeyStore(
      new FakeRedis(),
      foundationEnv.KEY_ENCRYPTION_SECRET,
    );
    await expect(
      store.set('google_ai', 'placeholder-key', 3600),
    ).rejects.toThrow('Invalid provider key');
    await expect(store.set('openai', 'bad\nheader', 3600)).rejects.toThrow(
      'Invalid provider key',
    );
    await expect(store.set('openai', 'placeholder-key', 0)).rejects.toThrow(
      'Invalid key lifetime',
    );
  });
});
