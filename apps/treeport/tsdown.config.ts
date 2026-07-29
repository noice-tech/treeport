import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'node/cli/index': 'src/cli/index.ts',
    'node/server/index': 'src/server/index.ts',
    'node/server/core/launcher': 'src/server/core/launcher.ts'
  },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  fixedExtension: false,
  outDir: 'dist',
  clean: false,
  sourcemap: false,
  dts: false,
  deps: {
    neverBundle: true,
    alwaysBundle: ['@treeport/shared']
  }
})
