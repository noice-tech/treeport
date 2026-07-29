import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  fixedExtension: false,
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  dts: false,
  deps: {
    neverBundle: true,
    alwaysBundle: ['@treeport/shared']
  }
})
