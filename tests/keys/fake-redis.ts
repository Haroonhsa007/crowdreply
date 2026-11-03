import type { KeyRedis } from '../../src/keys/redis-key-store.js';
export class FakeRedis implements KeyRedis {
  values = new Map<string, { value: string; until: number }>();
  constructor(readonly clock: () => number = Date.now) {}
  async get(key: string) {
    const record = this.values.get(key);
    return record && record.until > this.clock() ? record.value : null;
  }
  async set(key: string, value: string, _expiry: 'EX', seconds: number) {
    this.values.set(key, { value, until: this.clock() + seconds * 1000 });
    return 'OK';
  }
  async del(key: string) {
    return this.values.delete(key) ? 1 : 0;
  }
}
