import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:8000',
    },
    // Polling нужен для Docker на Windows — inotify события не пробрасываются
    watch: {
      usePolling: true,
      interval: 1000,
    },
  },
})
