import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const server = process.env.MCV_SERVER ?? 'http://localhost:3000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': server,
      '/media': server,
      '/healthz': server,
      '/socket.io': { target: server, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
})
