import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const configuredRendererPort = Number.parseInt(
  process.env.TREEPORT_DESKTOP_RENDERER_PORT ?? '',
  10
)

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    preserveSymlinks: false
  },
  root: path.resolve('src/shell'),
  base: './',
  server: {
    host: 'localhost',
    port: Number.isInteger(configuredRendererPort) ? configuredRendererPort : 0,
    strictPort: Number.isInteger(configuredRendererPort)
  },
  build: {
    copyPublicDir: false,
    emptyOutDir: true,
    outDir: path.resolve('.vite/renderer/main_window')
  }
})
