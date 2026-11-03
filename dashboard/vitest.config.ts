import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const path = (value: string) => fileURLToPath(new URL(value, import.meta.url));
export default defineConfig({
  resolve: {
    alias: {
      '@': path('./src'),
      '@contracts': path('../src/contracts/index.ts'),
      'server-only': path('./tests/server-only.ts'),
    },
  },
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['./tests/setup.ts'],
    clearMocks: true,
  },
});
