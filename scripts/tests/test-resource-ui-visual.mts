// Isolated Vite/Playwright fixture: compiles the real panel, no shared dist or user browser.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from '@playwright/test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, 'scripts/archive/office-completion/resource-ui')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-resource-visual-'))
fs.mkdirSync(output, { recursive: true })
const initial = () => ({ ok: true, configured: true, managementEnabled: true, busy: false, mounted: true,
  current: { identity: 'a'.repeat(64), releaseId: 'characters-v1', files: 160 }, canRollback: true,
  recoveryRequired: false, issue: null, task: null, releases: [
    { id: 'portraits', label: '角色立绘 · 秋日收藏', kind: 'full', source: 'offline', identity: 'b'.repeat(64), downloaded: false },
    { id: 'portraits-hd', label: '高清资源 · 秋日收藏', kind: 'delta', source: 'http', identity: 'c'.repeat(64), downloaded: false },
  ] })
const task = (action: any, state: any = 'running') => ({ id: 'e58ce240-61d8-4a71-a496-bcbd4e74a7d5', action,
  releaseId: 'portraits', resumeAction: null, state, phase: 'copy-progress', bytes: 30, total: 100,
  startedAt: 1, finishedAt: 0, error: null })
let server, browser
try {
  server = await createServer({ root, configFile: false, cacheDir: path.join(temporary, 'cache'),
    resolve: { alias: { '@': path.join(root, 'src') } },
    plugins: [vue(), { name: 'isolated-resource-ui', configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/resource-fixture') return next()
        const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>资源面板隔离验收</title>
<body style="margin:0;background:var(--bg-base);font-family:var(--font-sans)"><main style="max-width:1000px;margin:0 auto;padding:24px"><div id="app"></div></main>
<script type="module">import {createApp} from 'vue';import Panel from '/src/components/ResourceLibraryPanel.vue';import '/src/assets/css/design-system.css';import '/src/assets/css/light-theme.css';createApp(Panel).mount('#app')</script></body></html>`
        res.setHeader('Content-Type', 'text/html')
        res.end(await server.transformIndexHtml('/resource-fixture', html))
      })
    } }], server: { host: '127.0.0.1', port: 0, strictPort: true,
      watch: { ignored: ['**/desktop-tauri/**', '**/runtime/**'] } }, logLevel: 'error' })
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer!.address!().port}`
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32'
    ? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(file => fs.existsSync(file)) : undefined)
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  const results = []
  for (const theme of ['dark', 'light']) {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 })
      const page = await context.newPage()
      let state = initial()
      const errors: any = []
      const writes: any = []
      page.on('pageerror', error => errors.push(error.message))
      await page.route('**/api/resources/**', route => {
        const request = route.request()
        if (request.method() === 'POST') {
          const body = request.postDataJSON()
          writes.push({ url: request.url(), body })
          if (request.url().endsWith('/cancel')) state = { ...state, busy: false, recoveryRequired: true, task: task('import', 'cancelled') }
          else if (body.action === 'recover') state = { ...state, busy: false, mounted: true, recoveryRequired: false, task: task('recover', 'completed') }
          else state = { ...state, busy: true, mounted: false, task: task(body.action) }
          return route.fulfill({ status: 202, json: { ok: true, task: state.task } })
        }
        return route.fulfill({ json: state })
      })
      await page.goto(origin + '/resource-fixture')
      await page.locator('select').waitFor()
      await page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
      await page.getByRole('button', { name: '安装所选版本' }).waitFor()
      await page.screenshot({ path: path.join(output, `${theme}-${width}-ready.png`), fullPage: true })
      const check = await page.evaluate(() => {
        const rgb = (value: any) => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number)
        const luminance = (values: any) => values.map((v: any) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
          .reduce((sum: any, value: any, index: any) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
        const contrast = (a: any, b: any) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
        const failures = []
        let minimum = Infinity
        for (const element of document.querySelectorAll('.resource-library :is(p,span,h2,label,select,button,code,strong)')) {
          if (!element.textContent.trim() || !element.getBoundingClientRect().height) continue
          const style = getComputedStyle(element)
          let ancestor = element!!!!, background
          while (ancestor) {
            const color = getComputedStyle(ancestor).backgroundColor
            if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') { background = color; break }
            ancestor = ancestor.parentElement
          }
          const ratio = contrast(rgb(style.color), rgb(background || 'rgb(255,255,255)'))
          minimum = Math.min(minimum, ratio)
          const threshold = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700) ? 3 : 4.5
          if (ratio < threshold) failures.push({ text: element.textContent.slice(0, 50), ratio, threshold })
        }
        return { overflow: document.documentElement.scrollWidth > innerWidth, minimum, failures }
      })
      assert.equal(check.overflow, false, 'Panel overflows viewport')
      assert.deepEqual(check.failures, [], 'Text contrast must meet AA')
      await page.getByRole('button', { name: '安装所选版本' }).click()
      await page.getByRole('button', { name: '取消操作' }).waitFor()
      assert.equal(await page.getByRole('button', { name: '安装所选版本' }).isDisabled(), true)
      await page.getByRole('button', { name: '取消操作' }).click()
      await page.getByRole('button', { name: '继续恢复' }).waitFor()
      await page.getByRole('button', { name: '继续恢复' }).click()
      await page.getByText('资源操作已完成', { exact: true }).waitFor()
      state = { ...initial(), mounted: false, recoveryRequired: true, issue: { code: 'CONTENT_INVALID', message: '资源内容校验失败，正在使用随包基础资源。' }, task: { ...task('import', 'failed'), error: { code: 'ENOSPC', message: '磁盘空间不足，原有资源仍被保留。' } } }
      const refresh = page.getByRole('button', { name: '重新检查' })
      await refresh.focus(); await refresh.press('Enter')
      await page.getByText('资源操作失败', { exact: true }).waitFor()
      await page.screenshot({ path: path.join(output, `${theme}-${width}-failure.png`), fullPage: true })
      assert.deepEqual(writes.map((item: any) => item.body.action || 'cancel'), ['import', 'cancel', 'recover'])
      assert.deepEqual(errors, [])
      results.push({ theme, width, ...check, interactions: 'import/cancel/recover/keyboard refresh PASS' })
      await context.close()
    }
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ ok: true, results }, null, 2))
  console.log(JSON.stringify({ ok: true, viewports: results.length, output, results }))
} finally {
  await browser?.close()
  await server?.close()
  fs.rmSync(temporary, { recursive: true, force: true })
}
