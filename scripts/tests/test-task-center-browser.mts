import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { startRustBrowserFixture } from './rust-browser-fixture.mjs'
const fixture = await startRustBrowserFixture()
const { origin, bootstrap } = fixture
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
const completed = await fixture.request('/api/tasks/v1', 'POST', { kind: 'generation', requestKey: 'complete', input: { prompt: 'Fixture landscape', seed: 0, width: 832, height: 1216 }, context: { char: 'nene', story: '冻结的原始故事' } })
const deadline = Date.now() + 30_000
while (true) {
  const task = await fixture.request('/api/tasks/v1/' + completed.taskId)
  if (task.upstreamSettled) { assert.equal(task.status, 'succeeded'); assert.equal(task.resultState, 'available'); break }
  assert.ok(Date.now() < deadline, 'isolated upstream result must settle before the UI opens')
  await new Promise(resolve => setTimeout(resolve, 50))
}
const html = `<!doctype html><html data-theme="dark"><meta charset="utf-8"><title>Task inbox fixture</title><div id="app"></div><script type="module">
import {createApp,h} from '/node_modules/vue/dist/vue.esm-bundler.js';
import {createRouter,createWebHistory} from '/node_modules/vue-router/dist/vue-router.mjs';
import TaskCenter from '/src/components/tasks/TaskCenter.vue';
import Button from '/src/components/tasks/TaskCenterButton.vue';
import '/src/assets/css/design-system.css'; import '/src/assets/css/light-theme.css'; import '/src/assets/css/native-controls.css';
import {initializePlatform} from '/src/platform/initializePlatform.ts';
await initializePlatform(()=>false);
const router=createRouter({history:createWebHistory(),routes:[{path:'/:pathMatch(.*)*',component:{render:()=>null}}]});
createApp({render:()=>h('main',{style:'padding:32px'},[h(Button),h(TaskCenter)])}).use(router).mount('#app');
</script></html>`
const executablePath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(file => fs.existsSync(file))
browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  const context = await fixture.context(browser, html, { viewport: { width: 1100, height: 850 } })
  await context.addInitScript(descriptor => Object.assign(window, { __TAURI__: { core: { invoke: async () => descriptor }, event: { listen: async () => () => {} } } }), bootstrap)
  const page = await context.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin + '/fixture'); await page.getByRole('button', { name: '任务', exact: false }).first().click()
  await page.getByRole('heading', { name: '任务中心' }).waitFor()
  try { await page.getByText('结果已保存在收件箱，尚未入册。').waitFor({ timeout: 8000 }) }
  catch (error) { console.log(await page.locator('body').innerText(), errors, await page.evaluate(async () => (await import(String('/src/platform/desktop/runtime.ts'))).getDesktopRuntime())); throw error }
  const evidence = path.resolve('runtime/refactor-mainline'); fs.mkdirSync(evidence, { recursive: true })
  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
    await page.screenshot({ path: path.join(evidence, `task-center-${theme}.png`), animations: 'disabled' })
    assert.equal(await page.locator('dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true)
    const minimum = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
      const ctx = canvas.getContext('2d')!
      const rgba = (value: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].map((v, index) => index === 3 ? v / 255 : v) }
      const blend = (front: number[], back: number[]) => front.slice(0, 3).map((v, i) => v * front[3] + back[i] * (1 - front[3])).concat(1)
      const luminance = (rgb: number[]) => rgb.slice(0, 3).map(v => { const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4 }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
      return Math.min(...[...document.querySelectorAll('.runtime-task-list button, .runtime-task-list a, .runtime-task-list p, .runtime-task-list strong, .runtime-task-list span, .runtime-task-list time')].filter(el => el.getBoundingClientRect().height && el.textContent?.trim()).map(el => {
        const layers: number[][] = []; let parent: Element | null = el
        while (parent) { layers.push(rgba(getComputedStyle(parent).backgroundColor)); parent = parent.parentElement }
        const background = layers.reverse().reduce((back, front) => blend(front, back), [255, 255, 255, 1])
        const foreground = blend(rgba(getComputedStyle(el).color), background)
        const a = luminance(foreground), b = luminance(background)
        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
      }))
    })
    assert.ok(minimum >= 4.5, `${theme} task text contrast ${minimum.toFixed(2)} must meet AA`)
  }
  await page.getByRole('button', { name: '查看结果', exact: true }).click()
  await page.getByRole('img', { name: '生成结果' }).waitFor()
  await page.getByRole('button', { name: '保存到作品册', exact: true }).click()
  await page.getByRole('button', { name: '已入册', exact: true }).waitFor()
  const rows = await fixture.request('/api/workspace/artworks')
  assert.equal(rows.items.length, 1); assert.equal(rows.items[0].body.story, '冻结的原始故事'); assert.equal(rows.items[0].body.seed, 0)
  await page.reload(); await page.getByRole('button', { name: '任务', exact: false }).first().click(); await page.getByText('结果已入册。').waitFor()
  await page.getByRole('button', { name: '移出收件箱', exact: true }).click()
  await page.getByRole('button', { name: '确认移出', exact: true }).click()
  await page.getByText('结果已移出收件箱，已入册作品保留。').waitFor()
  assert.equal((await fixture.request('/api/workspace/artworks')).items.length, 1)
  assert.deepEqual(errors, [])
  console.log('Task Center: private HTTP/SQLite task list, both themes, reliable result preview, stable save without byte duplication and reload receipt passed. Isolated browser; no real provider calls.')
  await context.close()
} finally { try { await fixture.close() } finally { await browser?.close() } }
