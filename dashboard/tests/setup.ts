import { webcrypto } from 'node:crypto';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
vi.stubGlobal('crypto', webcrypto);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
