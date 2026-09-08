import { defineConfig } from 'vitest/config'

// Direct runs must not inherit the managing Treeport instance's paths or credentials.
for (const name of Object.keys(process.env)) {
  // The browser executable is a test input, not an instance address or credential.
  if (name.startsWith('TREEPORT_') && name !== 'TREEPORT_BROWSER_EXECUTABLE') {
    delete process.env[name]
  }
}

// Browser decoding and subprocess readiness share host resources. Run files
// serially so host load cannot starve native browser and terminal boundaries.
export default defineConfig({
  test: {
    fileParallelism: false,
    include: [
      'apps/**/*.integration.test.ts',
      'scripts/**/*.integration.test.mjs'
    ],
    environment: 'node',
    testTimeout: 20_000
  }
})
