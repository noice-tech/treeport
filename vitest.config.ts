import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/**/*.test.ts',
      'apps/**/*.test.ts',
      'apps/**/*.test.tsx',
      'scripts/**/*.test.mjs'
    ],
    exclude: [
      '**/*.integration.test.ts',
      '**/*.real.test.ts',
      '**/node_modules/**'
    ],
    environment: 'node',
    coverage: { reporter: ['text', 'html'] }
  }
})
