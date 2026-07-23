import { builtinModules } from 'node:module'
import path from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    copyPublicDir: false,
    emptyOutDir: false,
    outDir: '.vite/build',
    lib: {
      entry: path.resolve('src/main.ts'),
      fileName: () => 'main.js',
      formats: ['cjs']
    },
    rollupOptions: {
      external: [
        'electron',
        'electron/main',
        ...builtinModules,
        ...builtinModules.map((module) => `node:${module}`)
      ]
    }
  }
})
