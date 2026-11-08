import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@tsinspect/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@tsinspect/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
