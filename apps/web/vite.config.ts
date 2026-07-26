import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const apiTarget =
  process.env.TREEPORT_API_URL?.trim() || 'http://127.0.0.1:4780'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    allowedHosts: ['.ts.net'],
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
