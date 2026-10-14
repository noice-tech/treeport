import { defineConfig } from 'vitest/config'

// Direct runs must not inherit the managing Treeport instance's paths or credentials.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('TREEPORT_')) {
    delete process.env[name]
  }
}

// Bound PTY/storage pressure while letting independent files overlap their
// process and timeout waits. Tests within each file remain sequential.
export default defineConfig({
  test: {
    maxWorkers: 2,
    include: [
      'apps/**/*.integration.test.ts',
      'scripts/**/*.integration.test.mjs'
    ],
    environment: 'node',
    testTimeout: 20_000
  }
})
