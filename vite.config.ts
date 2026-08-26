import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages hosts this project under /annotation_volly/.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? '/annotation_volly/' : '/',
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  server: {
    watch: {
      ignored: ['**/backend/**', '**/node_modules/**'],
    },
  },
}))
