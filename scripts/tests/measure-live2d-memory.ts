/**
 * Live2D 内存测量脚本（路径 B 验收工具）。
 *
 * 目标：量化"Live2D 渲染移出 WebView2"的收益。
 * 用法（需网关已启动，如 `npm run dev:server`）：
 *
 *   node scripts/tests/measure-live2d-memory.js [--base-url http://127.0.0.1:3000]
 *
 * 流程：打开 /chat → 注入 localStorage 启用 Live2D（宁宁）→ 等
 * .live2d-host[data-state=ready] → CDP SystemInfo.getProcessInfo 读取
 * WebView2 进程组内存 → 输出 JSON。
 *
 * 输出字段：renderingProcessPrivateMB / gpuProcessPrivateMB / webview2TotalMB
 * （privateMemoryUsage 累加，单位换算为 MB）。桌面原生 overlay 接入后跑
 * 同一脚本对比，即为验收数字。
 */
const { chromium }: typeof import('@playwright/test') = require('@playwright/test');
const { existsSync }: typeof import('node:fs') = require('node:fs');

const args = process.argv.slice(2);
const baseUrl = (() => {
  const flag = args.find((item) => item.startsWith('--base-url='));
  return flag ? flag.split('=')[1] : 'http://127.0.0.1:3000';
})();

// 与 playwright.config.ts 一致：优先系统 Edge/Chrome，避免依赖本地 playwright 浏览器下载
const localChromiumCandidates = process.platform === 'win32' ? [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
] : [];
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  localChromiumCandidates.find((candidate) => existsSync(candidate));

async function main() {
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.addInitScript(() => {
      localStorage.setItem('aics_chat_v1', JSON.stringify({
        version: 3,
        active: 'nene',
        histories: { nene: [], natsume: [] },
        settings: {
          model: '', provider: 'api', apiBaseUrl: '', apiModel: '', apiKey: '',
          webSearchEnabled: false, live2dEnabled: true, live2dOutfit: 'school',
          live2dOutfits: { nene: 'school', natsume: 'natsume-cafe' },
          autoVoice: false, volume: 80, drafts: { nene: '', natsume: '' },
        },
      }));
    });
    await page.goto(`${baseUrl}/chat`);
    await page.locator('.live2d-host').waitFor({ state: 'attached', timeout: 30_000 });
    await page.waitForFunction(() => {
      const host = document.querySelector('.live2d-host');
      return host?.getAttribute('data-state') === 'ready';
    }, { timeout: 45_000 });

    // 等待几秒让贴图上传与 GC 稳定，再采样
    await page.waitForTimeout(5_000);

    const client = await browser.newBrowserCDPSession();
    const info = await client.send('SystemInfo.getProcessInfo');
    const processes = info.processInfo;
    const byType: any = {};
    let totalMB = 0;
    let hasPrivateMemory = false;
    for (const proc of processes) {
      if (typeof proc.privateMemoryUsage !== 'number') continue;
      hasPrivateMemory = true;
      const mb = proc.privateMemoryUsage / (1024 * 1024);
      totalMB += mb;
      if (!byType[proc.type]) byType[proc.type] = 0;
      byType[proc.type] += mb;
    }

    // CDP 不提供 privateMemoryUsage 时（部分 Edge/Chromium 版本）：补两个
    // 可用的内存观测点 —— 渲染进程 JS heap（CDP Runtime.getHeapUsage 需
    // 页面 target，这里用 performance.memory）与进程级 WorkingSet 快照。
    let jsHeapMB = null;
    try {
      jsHeapMB = await page.evaluate(() => {
        const memory = performance.memory;
        return memory && typeof memory.usedJSHeapSize === 'number'
          ? Math.round((memory.usedJSHeapSize / (1024 * 1024)) * 10) / 10
          : null;
      });
    } catch { /* 非 Chromium 或受限环境 */ }
    let processWorkingSetMB = null;
    if (!hasPrivateMemory) {
      try {
        const { execFileSync }: typeof import('node:child_process') = require('node:child_process');
        const stdout = execFileSync('powershell', [
          '-NoProfile', '-Command',
          "Get-Process msedge,chrome,msedgewebview2 -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum | Select-Object -ExpandProperty Sum",
        ], { encoding: 'utf8', timeout: 15_000 });
        const bytes = Number(stdout.trim());
        if (Number.isFinite(bytes) && bytes > 0) {
          processWorkingSetMB = Math.round((bytes / (1024 * 1024)) * 10) / 10;
        }
      } catch { /* PowerShell 不可用 */ }
    }

    const result = {
      baseUrl,
      sampledAt: new Date().toISOString(),
      processes: processes.map((proc) => ({
        type: proc.type,
        cpuTime: proc.cpuTime,
        privateMemoryMB: typeof proc.privateMemoryUsage === 'number'
          ? Math.round((proc.privateMemoryUsage / (1024 * 1024)) * 10) / 10
          : null,
      })),
      webview2TotalMB: hasPrivateMemory ? Math.round(totalMB * 10) / 10 : null,
      perTypeMB: hasPrivateMemory
        ? Object.fromEntries(Object.entries(byType).map(([type, mb]: any) => [type, Math.round(mb * 10) / 10]))
        : null,
      jsHeapMB,
      processWorkingSetMB,
      hint: '桌面原生 overlay 接入后跑同一脚本对比此值',
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('测量失败：', error);
  process.exit(1);
});
