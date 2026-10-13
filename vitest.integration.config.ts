import { defineConfig } from 'vitest/config'

// Direct runs must not inherit the managing Treeport instance's paths or credentials.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('TREEPORT_')) {
    delete process.env[name]
  }
}

// PTY and storage fixtures are resource-heavy. Run files serially alongside
// the unit and static gate checks; tests still exercise internal concurrency.
export default defineConfig({
  test: {
    maxWorkers: 1,
    include: [
      'apps/**/*.integration.test.ts',
      'scripts/**/*.integration.test.mjs'
    ],
    environment: 'node',
    testTimeout: 20_000
  }
})
