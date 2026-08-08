import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  publicDir: 'web/public',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist/web',
    emptyOutDir: true
  },
  server: {
    allowedHosts: ['.ts.net']
  }
})
