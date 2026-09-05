import { defineConfig } from 'vitest/config'

// Tests must not inherit the managing Treeport instance's paths or credentials.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('TREEPORT_')) {
    delete process.env[name]
  }
}

export default defineConfig({
  test: {
    include: [
      'packages/**/*.test.ts',
      'apps/**/*.test.ts',
      'apps/**/*.test.tsx',
      'scripts/**/*.test.mjs',
      'tools/**/*.test.mjs'
    ],
    exclude: [
      '**/*.integration.test.ts',
      '**/*.integration.test.mjs',
      '**/*.real.test.ts',
      '**/node_modules/**'
    ],
    environment: 'node',
    coverage: { reporter: ['text', 'html'] }
  }
})
