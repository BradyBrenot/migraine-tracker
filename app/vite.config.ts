/// <reference types="vitest/config" />
import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/',
  plugins: [inspectAttr(), react()],
  server: {
    port: 3000,
    proxy: {
      // during local dev, forward API calls to the backend on :3100
      '/api': 'http://localhost:3100',
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // Pure unit tests only — the server has its own `node --test` suite
    // (run via `npm test --prefix server`), and no jsdom/network/storage.
    environment: 'node',
    include: ['shared/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
  },
});
