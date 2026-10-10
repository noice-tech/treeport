import { constants } from 'node:zlib'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import compression from 'compression'
import { type Connect, defineConfig } from 'vite'

export default defineConfig({
  publicDir: 'web/public',
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'treeport-dev-compression',
      configureServer(server) {
        // Compress remote dev assets without buffering API streams or touching HMR.
        // SAFETY: compression uses Node HTTP APIs; its types unnecessarily require Express.
        server.middlewares.use(
          compression({
            level: constants.Z_BEST_SPEED,
            brotli: {
              params: { [constants.BROTLI_PARAM_QUALITY]: 1 }
            },
            filter(request, response) {
              return (
                /^(text\/(html|css|javascript)|application\/javascript)(?:;|$)/u.test(
                  String(response.getHeader('Content-Type'))
                ) && compression.filter(request, response)
              )
            }
          }) as Connect.NextHandleFunction
        )
      }
    }
  ],
  build: {
    outDir: 'dist/web',
    emptyOutDir: true
  },
  server: {
    allowedHosts: ['.ts.net']
  }
})
