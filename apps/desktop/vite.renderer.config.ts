import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const configuredRendererPort = Number.parseInt(
  process.env.TREEPORT_DESKTOP_RENDERER_PORT ?? '',
  10
)
const fixedRendererPort = Number.isInteger(configuredRendererPort)
interface RendererHmr {
  host: string
  port?: number
}
const rendererHmr: RendererHmr = { host: 'localhost' }
if (fixedRendererPort) {
  rendererHmr.port = configuredRendererPort
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    preserveSymlinks: false,
    dedupe: ['react', 'react-dom'],
    alias: {
      '@treeport-web': path.resolve('../treeport/src/web')
    }
  },
  root: path.resolve('src/shell'),
  base: '/',
  server: {
    host: 'localhost',
    port: fixedRendererPort ? configuredRendererPort : 0,
    strictPort: fixedRendererPort,
    hmr: rendererHmr,
    fs: {
      allow: [path.resolve('../..')]
    }
  },
  build: {
    copyPublicDir: false,
    emptyOutDir: true,
    outDir: path.resolve('.vite/renderer/main_window')
  }
})
