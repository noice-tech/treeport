import { defineConfig } from 'vitest/config'

// Direct runs must not inherit the managing Treeport instance's paths or credentials.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('TREEPORT_')) {
    delete process.env[name]
  }
}

// Bound subprocess load while allowing independent fixtures
// to overlap. Tests own separate runtime directories and ephemeral listeners.
export default defineConfig({
  test: {
    maxWorkers: 3,
    include: [
      'apps/**/*.integration.test.ts',
      'scripts/**/*.integration.test.mjs'
    ],
    environment: 'node',
    testTimeout: 20_000
  }
})
