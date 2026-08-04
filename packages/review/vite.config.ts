import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../web-panels/review',
    emptyOutDir: true,
    rollupOptions: {
      external: [
        '@pierre/diffs',
        '@pierre/diffs/react',
        '@pierre/trees/react',
        '@treeport/panel-sdk',
        'react',
        'react-dom/client',
        'react/jsx-runtime'
      ],
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
})
