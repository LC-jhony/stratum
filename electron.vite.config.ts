import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: resolve('src/main/index.ts') } } },
  preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: resolve('src/preload/index.ts') } } },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    // electron-vite disables minification by default for every target; the renderer is the one that
    // ships to users (10.4 MB unminified with Monaco + ELK), while main/preload stay readable.
    build: { minify: 'esbuild', rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
})
