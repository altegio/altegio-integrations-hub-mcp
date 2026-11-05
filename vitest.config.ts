import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
    maxWorkers: 2,
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/index.ts'] },
  },
});
