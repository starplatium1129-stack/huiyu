import { defineConfig } from '@playwright/test'
import regression from './playwright.config'

// Benchmarks run separately, without competing browser workers or mock resets.
export default defineConfig({
  ...regression,
  workers: 1,
  projects: [
    { name: 'performance', testMatch: /office-performance\.bench\.ts$/ },
    { name: 'fluidity', testMatch: /ui-fluidity\.bench\.ts$/, use: { trace: 'off' } },
    { name: 'fluidity-office', testMatch: /ui-fluidity-office\.bench\.ts$/, use: { trace: 'off' } },
  ],
  webServer: Array.isArray(regression.webServer) ? regression.webServer[0] : regression.webServer,
  outputDir: 'runtime/office-code-2026-09-11/performance-traces',
})
