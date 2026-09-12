import { defineConfig } from 'vitest/config'

// Release qualification must not inherit a managing Treeport instance.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('TREEPORT_')) {
    delete process.env[name]
  }
}

export default defineConfig({
  test: {
    include: ['scripts/terminal-api.release.mjs'],
    environment: 'node',
    testTimeout: 20_000
  }
})
