import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The migrated Pet module suites use Vitest; the Desktop shell suites keep
    // the Node test runner (`tsx --test test/*.test.ts`).
    include: ['test/pet/**/*.test.ts'],
    environment: 'node',
  },
});
