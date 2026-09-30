import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import MOCK_PORTS from './scripts/lib/e2e-ports.js';
import selection from './scripts/lib/e2e-selection.js';
import lanes from './tests/e2e/e2e-lanes.json';

const localChromiumCandidates = process.platform === 'win32' ? [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  // Chrome can exist on disk while its enterprise/profile bootstrap exits before
  // Playwright attaches. Edge is the stable local smoke-test runtime on Windows.
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
] : [];
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  localChromiumCandidates.find(candidate => existsSync(candidate));

const browserUse = {
  baseURL: `http://127.0.0.1:${MOCK_PORTS.web}`,
  trace: 'retain-on-failure' as const,
  screenshot: 'only-on-failure' as const,
  // Real getUserMedia policy tests use a synthetic device, never the operator's microphone.
  launchOptions: { ...(executablePath ? { executablePath } : {}), args: ['--use-fake-device-for-media-stream'] }
};

/**
 * 使用共享模拟上游的套件统一放入单 worker 项目，避免一个用例的 reset/fault
 * 清除另一个用例的任务或污染请求断言。普通页面与设备回归仍可并行。
 */
const { MOCK_SPECS } = selection;
const servers = selection.selectE2eServers(process.argv.slice(2), lanes.specs.map(spec => spec.file));

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  // 共享模拟服务由 flows 项目的单 worker 独占；其他项目继续并行。
  workers: process.env.CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['line']] : 'line',
  use: {
    ...browserUse,
    viewport: { width: 1440, height: 960 }
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: MOCK_SPECS,
      use: { ...browserUse, viewport: { width: 1440, height: 960 } }
    },
    {
      name: 'flows',
      testMatch: MOCK_SPECS,
      workers: 1,
      use: {
        ...browserUse,
        baseURL: `http://127.0.0.1:${MOCK_PORTS.gateway}`,
        viewport: { width: 1440, height: 1200 }
      }
    }
  ],
  webServer: [
    ...servers.includes('web') ? [{
      command: 'node scripts/tests/mock-stack.js --web-only',
      url: `http://127.0.0.1:${MOCK_PORTS.web}/api/health`,
      // A pre-existing Node or operator gateway must never certify Rust E2E.
      reuseExistingServer: false,
      timeout: 60_000,
    }] : [],
    ...servers.includes('gateway') ? [{
      // Programmable upstream fixtures + the real Rust release executable.
      command: 'node scripts/tests/mock-stack.js',
      url: `http://127.0.0.1:${MOCK_PORTS.gateway}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    }] : []
  ]
});
