import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const apiTarget =
  process.env.TREEPORT_API_URL?.trim() || 'http://127.0.0.1:4780'
const webHost = process.env.TREEPORT_WEB_HOST?.trim() || '0.0.0.0'
const webPort = Number.parseInt(
  process.env.TREEPORT_WEB_PORT?.trim() || '5173',
  10
)

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: webHost,
    port: webPort,
    strictPort: true,
    open: false,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        xfwd: true,
        ws: true,
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyRequest, request) => {
            if (request.headers.host) {
              proxyRequest.setHeader('x-forwarded-host', request.headers.host)
            }
          })
        }
      }
    }
  }
})
