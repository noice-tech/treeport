import { defineConfig } from 'vitest/config'

// Direct runs must not inherit the managing Treeport instance's paths or credentials.
for (const name of Object.keys(process.env)) {
  // The browser executable is a test input, not an instance address or credential.
  if (name.startsWith('TREEPORT_') && name !== 'TREEPORT_BROWSER_EXECUTABLE') {
    delete process.env[name]
  }
}

// Bound native browser and subprocess load while allowing independent fixtures
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
