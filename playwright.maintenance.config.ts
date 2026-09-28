import { defineConfig } from '@playwright/test'

const url = process.env.AICS_NATIVE_ACCEPTANCE_URL
if (!url || new URL(url).hostname !== '127.0.0.1' || process.env.AICS_NATIVE_ACCEPTANCE_ISOLATED !== '1') {
  throw new Error('Maintenance acceptance requires an explicitly isolated local runtime: AICS_NATIVE_ACCEPTANCE_URL and AICS_NATIVE_ACCEPTANCE_ISOLATED=1')
}

// The caller owns the temporary Rust runtime and full UI server. Never start the
// legacy mock gateway, reuse an operator profile, or silently skip this suite.
export default defineConfig({
  testDir: './tests/e2e', testMatch: 'desktop-maintenance-runtime.spec.ts',
  workers: 1, timeout: 120_000, expect: { timeout: 15_000 }, retries: 0,
  reporter: [['list'], ['json', { outputFile: 'runtime/maintenance-acceptance/e2e-results.json' }]],
  outputDir: 'runtime/maintenance-acceptance/e2e',
  use: {
    baseURL: url, viewport: { width: 1920, height: 1080 }, headless: true,
    ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
})
