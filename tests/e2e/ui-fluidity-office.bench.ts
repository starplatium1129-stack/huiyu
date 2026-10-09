import { test, expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { platform, release } from 'node:os'
import { OFFICE_FIXTURE, OFFICE_ROUTES, prepareOffice, previewRoundTrip, visitOfficeRoute, armPreviewAnchor, consumePreviewAnchor } from './helpers/ui-fluidity-office'
import { UI_FLUIDITY_FIXTURE } from './helpers/ui-fluidity-fixture'
import { measureIdleFrameInterval, startFrameProbe, stopFrameProbe, summarizeFrameProbe } from './helpers/ui-fluidity-measure'

declare global { interface Window { __officeFrameCount(): number } }
test.use({ actionTimeout: 15_000 })

// Default F0 stays at 20. Explicit longer sessions investigate heap trends;
// separate output directories preserve previously captured 20-cycle evidence.
const SAMPLES = Number(process.env.AICS_OFFICE_RESOURCE_SAMPLES || 20)
if (!Number.isInteger(SAMPLES) || SAMPLES < 20 || SAMPLES > 100) throw new Error('AICS_OFFICE_RESOURCE_SAMPLES must be an integer from 20 to 100')
const OUTPUT = SAMPLES === 20 ? 'runtime/ui-fluidity-office' : `runtime/ui-fluidity-office-${SAMPLES}`
const CAPTURE_HEAP = process.env.AICS_OFFICE_HEAP_SNAPSHOTS === '1'
const IDLE_MS = Number(process.env.AICS_OFFICE_IDLE_MS || 0)
if (!Number.isInteger(IDLE_MS) || IDLE_MS < 0 || IDLE_MS > 30_000) throw new Error('AICS_OFFICE_IDLE_MS must be an integer from 0 to 30000')
const ROUNDS = 3
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
function buildIdentity() {
  const files: string[] = []
  function walk(dir: string) { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.isFile()) files.push(path)
  } }
  walk('dist')
  const manifest = files.sort().map(path => `${relative('dist', path).replaceAll('\\', '/')}\0${hash(readFileSync(path))}`).join('\n')
  return { algorithm: 'sha256 of sorted relative-path NUL sha256(file) records', sha256: hash(manifest), files: files.length }
}
function captureIdentity() { return {
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
  build: buildIdentity(), fixtureSha256: hash(Buffer.concat([readFileSync('tests/e2e/helpers/ui-fluidity-fixture.ts'), readFileSync('tests/e2e/helpers/ui-fluidity-office.ts')])),
  fixture: { ...OFFICE_FIXTURE, base: UI_FLUIDITY_FIXTURE },
  platform: platform(), osRelease: release(), node: process.version,
} }
let identity: ReturnType<typeof captureIdentity>
test.beforeAll(() => { identity = captureIdentity() })
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]

async function showcaseRoundTrip(page: Page) {
  const trigger = page.locator('.showcase-grid .sample-visual').nth(4)
  await expect(trigger).toBeVisible(); await trigger.scrollIntoViewIfNeeded(); await trigger.focus()
  const preparedScrollY = await page.evaluate(() => scrollY)
  await armPreviewAnchor(trigger)
  await trigger.click(); const activation = await consumePreviewAnchor(trigger)
  const before = activation.scrollY; const viewer = page.locator('dialog.showcase-viewer[open]')
  await expect(viewer).toBeVisible(); await viewer.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(viewer).toHaveCount(0)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const after = await page.evaluate(() => scrollY)
  await expect(trigger).toBeFocused()
  expect(Math.abs(after - before), JSON.stringify({ preparedScrollY, atActivation: before, after })).toBeLessThanOrEqual(2)
  return { preparedScrollY, scrollBefore: before, scrollAfter: after, scrollError: Math.abs(after - before) }
}

for (const theme of ['dark']) for (const mode of ['full', 'low'] as const) {
  for (let run = 1; run <= ROUNDS; run++) {
    test(`009 office steady resources ${theme} ${mode} round ${run}`, async ({ page, context, browser }, testInfo) => {
      test.setTimeout(Math.max(240_000, SAMPLES * 12_000))
      await page.addInitScript(() => {
        const request = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window)
        const pending = new Set<number>()
        window.requestAnimationFrame = callback => {
          const id = request(now => { pending.delete(id); callback(now) }); pending.add(id); return id
        }
        window.cancelAnimationFrame = id => { pending.delete(id); cancel(id) }
        Object.defineProperty(window, '__officeFrameCount', { value: () => pending.size })
      })
      const writes = await prepareOffice(page, theme, mode)
      const dpr = await page.evaluate(() => devicePixelRatio)
      const cdp = await context.newCDPSession(page)
      await cdp.send('Performance.enable')
      const heapSnapshots: string[] = []
      async function captureHeap(label: string) {
        if (!CAPTURE_HEAP) return
        const chunks: string[] = []
        const collect = ({ chunk }: { chunk: string }) => chunks.push(chunk)
        cdp.on('HeapProfiler.addHeapSnapshotChunk', collect)
        try { await cdp.send('HeapProfiler.takeHeapSnapshot') }
        finally { cdp.off('HeapProfiler.addHeapSnapshotChunk', collect) }
        mkdirSync(OUTPUT, { recursive: true })
        const file = join(OUTPUT, `${theme}-${mode}-${run}-${label}.heapsnapshot`)
        writeFileSync(file, chunks.join('')); heapSnapshots.push(file)
      }
      async function snapshot(gc: boolean) {
        if (gc) { await page.waitForTimeout(120); await cdp.send('HeapProfiler.collectGarbage') }
        const metrics = await cdp.send('Performance.getMetrics')
        const dom = await cdp.send('Memory.getDOMCounters')
        const read = (name: string) => metrics.metrics.find(item => item.name === name)?.value ?? null
        const view = await page.evaluate(() => ({
          routeRoots: document.querySelectorAll('main > .route-view').length,
          mountedImages: document.images.length,
          loadedImages: [...document.images].filter(image => image.complete && image.naturalWidth > 0).length,
          pendingAnimationFrames: window.__officeFrameCount(),
          finiteAnimations: document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).length,
        }))
        return { gc, jsHeapUsedBytes: read('JSHeapUsedSize'), ...dom, ...view }
      }
      const rows: Array<Record<string, unknown>> = []
      const navTimes: Record<string, number[]> = Object.fromEntries(OFFICE_ROUTES.map(path => [path, []]))
      let complete = false
      let phase = 'warmup'
      let baseline: Awaited<ReturnType<typeof snapshot>> | null = null
      let idleResources: Awaited<ReturnType<typeof snapshot>> | null = null
      try {
        // Warm the same four views and previews measured below before the GC baseline.
        for (let warm = 0; warm < 3; warm++) for (const path of OFFICE_ROUTES) {
          phase = `warmup-${warm + 1}:${path}`
          await visitOfficeRoute(page, path)
          if (path === '/gallery') await previewRoundTrip(page)
          if (path === '/showcase') await showcaseRoundTrip(page)
        }
        phase = 'baseline-snapshot'; baseline = await snapshot(true)
        await captureHeap('baseline')
        for (const path of OFFICE_ROUTES) {
          phase = `mark-cache:${path}`
          await visitOfficeRoute(page, path)
          await page.locator('main > .route-view').evaluate((el, path) => el.setAttribute('data-office-cache', path), path)
        }
        phase = 'idle-frame-calibration'; const idleIntervalMs = await measureIdleFrameInterval(page)
        for (let sample = 1; sample <= SAMPLES; sample++) {
          await startFrameProbe(page)
          for (const path of OFFICE_ROUTES) {
            phase = `sample-${sample}:${path}`
            const started = await page.evaluate(() => performance.now())
            await visitOfficeRoute(page, path)
            await expect(page.locator('main > .route-view')).toHaveAttribute('data-office-cache', path)
            navTimes[path].push((await page.evaluate(() => performance.now())) - started)
          }
          const rawProbe = await stopFrameProbe(page)
          phase = `sample-${sample}:gallery-preview`
          await visitOfficeRoute(page, '/gallery')
          const gallery = await previewRoundTrip(page, sample % 2 === 0)
          phase = `sample-${sample}:showcase-preview`
          await visitOfficeRoute(page, '/showcase')
          const showcase = await showcaseRoundTrip(page)
          phase = `sample-${sample}:visibility`
          await visitOfficeRoute(page, '/video-studio')
          // Synthetic Page Visibility signal only: this is not native minimization or sleep.
          const hiddenFrames = await page.evaluate(async () => {
            const original = Object.getOwnPropertyDescriptor(document, 'hidden')
            const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
            try {
              Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
              Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
              document.dispatchEvent(new Event('visibilitychange'))
              await new Promise(resolve => setTimeout(resolve, 60))
              return window.__officeFrameCount()
            } finally {
              if (original) Object.defineProperty(document, 'hidden', original)
              else Reflect.deleteProperty(document, 'hidden')
              if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility)
              else Reflect.deleteProperty(document, 'visibilityState')
              document.dispatchEvent(new Event('visibilitychange'))
            }
          })
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
          phase = `sample-${sample}:resource-snapshot`
          const resources = await snapshot(sample % 10 === 0 || sample === SAMPLES)
          rows.push({ sample, gallery, showcase, hiddenFrames, resources, rawProbe, frameProxy: summarizeFrameProbe(rawProbe, idleIntervalMs) })
          if (resources.gc) console.log('009-OFFICE-CHECKPOINT', JSON.stringify({ theme, mode, run, sample, resources }))
          expect(resources.routeRoots).toBe(1)
          expect(writes).toEqual([])
        }
        phase = 'end-heap'; await captureHeap('end')
        if (IDLE_MS) {
          phase = 'idle-tail'; await page.waitForTimeout(IDLE_MS)
          idleResources = await snapshot(true)
          await captureHeap('idle')
        }
        complete = true
      } finally {
        mkdirSync(OUTPUT, { recursive: true })
        const navigation = Object.fromEntries(Object.entries(navTimes).map(([path, values]) => [path, {
          label: 'automation click through settled route; not INP or pure render cost', rawMs: values,
          p50Ms: values.length >= 20 ? percentile(values, .5) : null,
          p95Ms: values.length >= 20 ? percentile(values, .95) : null,
        }]))
        const report = {
          ...identity, theme, mode, run, expectedSamples: SAMPLES, completedSamples: rows.length, complete, lastPhase: phase,
          browser: browser.version(), viewport: page.viewportSize(), dpr, physicalRefreshRate: 'unknown; rAF proxy calibrated separately',
          load: 'synthetic fixture; no actual generation, microphone, Live2D model or concurrent build in this job',
          baseline, rows, navigation, unexpectedWrites: writes,
          diagnostics: { trace: testInfo.project.use.trace, captureHeap: CAPTURE_HEAP, idleMs: IDLE_MS, heapSnapshots, idleResources },
          boundaries: { gpuMemory: null, processMemory: null, textureBytes: null, physicalPresentation: null,
            nativeMinimizeResume: 'not run', nativeSleepResume: 'not run', realModelContent: 'not run',
            imageCounts: 'DOM and loaded-image counts, not decoded bitmap or GPU allocation bytes' },
          criteria: '009 F0-v1: 2px return error and zero correctness failures; calibrated frame candidates and >10% resource changes remain investigation signals, not softened pass thresholds',
        }
        writeFileSync(join(OUTPUT, `${theme}-${mode}-${run}.json`), JSON.stringify(report, null, 2) + '\n')
        console.log('009-OFFICE-SUMMARY', JSON.stringify({ theme, mode, run, complete, samples: rows.length, baseline,
          end: rows.at(-1)?.resources, source: identity.sourceCommit, build: identity.build.sha256 }))
        // A timeout may have closed the target; preserve the original failure and saved samples.
        await cdp.detach().catch(() => {})
      }
    })
  }
}
