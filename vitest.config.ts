import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['apps/**/tests/**/*.spec.ts', 'packages/**/tests/**/*.spec.ts'],
    passWithNoTests: true,
  },
})
