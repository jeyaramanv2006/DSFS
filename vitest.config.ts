import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    include: ['packages/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
