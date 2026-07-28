import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'core/launcher': 'src/core/launcher.ts'
  },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  fixedExtension: false,
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  copy: [{ from: 'drizzle/**/*', to: 'dist/drizzle', flatten: false }],
  deps: {
    neverBundle: true,
    alwaysBundle: ['@treeport/shared']
  }
})
