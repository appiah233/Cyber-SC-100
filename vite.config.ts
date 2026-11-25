import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/Cyber-SC-100/',
  plugins: [react()],
  build: { sourcemap: false },
})
