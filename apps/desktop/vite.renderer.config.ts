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
  plugins: [
    {
      name: 'desktop-shell-boundary',
      enforce: 'pre',
      load(id) {
        // Inspect resolved paths, not import spelling: aliases, re-exports and
        // transitive dependencies must not bundle the workspace or privileged
        // desktop implementation into the shell.
        const file = id.split('?')[0]!

        if (!path.isAbsolute(file)) {
          return
        }

        const repositoryPath = path
          .relative(path.resolve('../..'), file)
          .split(path.sep)
          .join('/')

        if (
          !repositoryPath.startsWith('../') &&
          !repositoryPath.startsWith('node_modules/') &&
          !repositoryPath.startsWith('apps/desktop/src/shell/') &&
          !(
            repositoryPath.startsWith('packages/theme/') &&
            repositoryPath.endsWith('.css')
          )
        ) {
          this.error(
            `Desktop shell cannot bundle ${repositoryPath}. Only shell code and shared theme assets belong here.`
          )
        }
      }
    },
    react(),
    tailwindcss()
  ],
  resolve: {
    preserveSymlinks: false,
    dedupe: ['react', 'react-dom']
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
