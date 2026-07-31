import { builtinModules } from 'node:module'
import path from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    copyPublicDir: false,
    emptyOutDir: false,
    outDir: '.vite/build',
    rollupOptions: {
      external: [
        'electron',
        'electron/renderer',
        ...builtinModules,
        ...builtinModules.map((module) => `node:${module}`)
      ],
      input: path.resolve('src/shell-preload.ts'),
      output: {
        assetFileNames: '[name].[ext]',
        chunkFileNames: '[name].js',
        entryFileNames: '[name].js',
        format: 'cjs',
        inlineDynamicImports: true
      }
    }
  }
})
