import { expect, type Locator, type Page } from '@playwright/test'

export type UiFluidityEvent = {
  id: number
  phase: 'intent' | 'feedback-committed' | 'shell-ready' | 'primary-ready' | 'settled' | 'cancelled'
  path: string
  at: number
}

export type NavigationMeasurement = {
  label: string
  path: string
  clickToPrimaryMs: number
  intentToPrimaryMs: number | null
  intentToSettledMs: number | null
  feedbackToPrimaryMs: number | null
  cancelled: boolean
  events: UiFluidityEvent[]
}

type NavigationTarget = { path: string; ready: Locator; label: string }

function currentPath(page: Page): string {
  const url = new URL(page.url())
  return `${url.pathname}${url.search}${url.hash}`
}

async function events(page: Page): Promise<UiFluidityEvent[]> {
  return page.evaluate(() => {
    const state = (window as Window & { __AICS_UI_FLUIDITY__?: { events?: UiFluidityEvent[] } }).__AICS_UI_FLUIDITY__
    return state?.events ? [...state.events] : []
  })
}

async function openMoreIfNeeded(page: Page, link: Locator): Promise<void> {
  if (await link.isVisible()) return
  const summary = page.locator('nav.nav .nav-more > summary')
  if (!(await summary.isVisible())) throw new Error('navigation archive summary is not visible')
  const open = await summary.evaluate(element => element.parentElement?.hasAttribute('open') === true)
  if (!open) await summary.click()
  await expect(link).toBeVisible()
}

export async function clickNavPath(page: Page, path: string): Promise<void> {
  const link = page.locator(`nav.nav a[href="${path}"]`).first()
  await expect(link).toHaveCount(1)
  await openMoreIfNeeded(page, link)
  const target = page.waitForURL(url => {
    const parsed = new URL(url.toString())
    return `${parsed.pathname}${parsed.search}${parsed.hash}` === path
  }, { timeout: 20_000 })
  await link.click()
  await target
}

export async function waitForPrimary(page: Page, locator: Locator): Promise<void> {
  await expect(locator).toBeVisible({ timeout: 20_000 })
}

export async function measureSpaNavigation(page: Page, target: NavigationTarget): Promise<NavigationMeasurement> {
  const before = await events(page)
  const beforeIds = new Set(before.map(event => event.id))
  const clickAt = await page.evaluate(() => performance.now())
  await clickNavPath(page, target.path)
  await waitForPrimary(page, target.ready)
  const primaryAt = await page.evaluate(() => performance.now())
  const path = currentPath(page)
  await page.evaluate(targetPath => {
    const state = (window as Window & { __AICS_UI_FLUIDITY__?: { mark?: (phase: UiFluidityEvent['phase'], path?: string) => void } }).__AICS_UI_FLUIDITY__
    state?.mark?.('primary-ready', targetPath)
  }, path)
  await expect.poll(async () => (await events(page)).some(event => event.path === path && event.phase === 'settled'), { timeout: 1_000 }).toBeTruthy().catch(() => undefined)
  const sampleEvents = (await events(page)).filter(event => event.path === path && !beforeIds.has(event.id))
  const intent = sampleEvents.find(event => event.phase === 'intent')
  const primary = [...sampleEvents].reverse().find(event => event.phase === 'primary-ready')
  const settled = [...sampleEvents].reverse().find(event => event.phase === 'settled')
  const feedback = sampleEvents.find(event => event.phase === 'feedback-committed')
  return {
    label: target.label,
    path,
    clickToPrimaryMs: primaryAt - clickAt,
    intentToPrimaryMs: intent && primary ? primary.at - intent.at : null,
    intentToSettledMs: intent && settled ? settled.at - intent.at : null,
    feedbackToPrimaryMs: feedback && primary ? primary.at - feedback.at : null,
    cancelled: sampleEvents.some(event => event.phase === 'cancelled'),
    events: sampleEvents,
  }
}

export async function markPrimaryReady(page: Page): Promise<void> {
  const path = currentPath(page)
  await page.evaluate(targetPath => {
    const state = (window as Window & { __AICS_UI_FLUIDITY__?: { mark?: (phase: UiFluidityEvent['phase'], path?: string) => void } }).__AICS_UI_FLUIDITY__
    state?.mark?.('primary-ready', targetPath)
  }, path)
}

export async function startFrameProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frames: number[] = []
    const longTasks: number[] = []
    let last = performance.now()
    let stopped = false
    let observer: PerformanceObserver | null = null
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration)
        })
        observer.observe({ type: 'longtask', buffered: false })
      } catch { observer = null }
    }
    const tick = (now: number) => {
      if (stopped) return
      frames.push(now - last)
      last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    ;(window as Window & { __AICS_FRAME_PROBE__?: { stop: () => unknown } }).__AICS_FRAME_PROBE__ = {
      stop: () => {
        stopped = true
        observer?.disconnect()
        return { frames, longTasks, longTaskSupported: observer !== null }
      },
    }
  })
}

export async function stopFrameProbe(page: Page): Promise<{ frames: number[]; longTasks: number[]; longTaskSupported: boolean } | null> {
  return page.evaluate(() => {
    const probe = (window as Window & { __AICS_FRAME_PROBE__?: { stop: () => unknown } }).__AICS_FRAME_PROBE__
    return probe?.stop() as { frames: number[]; longTasks: number[]; longTaskSupported: boolean } | null
  })
}

/**
 * 静止前台的 rAF 有效间隔 T（同一页面、同一显示刷新率、无交互）。
 * 计划 009 §4.2 要求掉帧判据按 1.5T 校准：60Hz 的 16.7ms 在 120Hz 前台会凭空
 * 制造候选，所以任何掉帧结论都必须带这一条校准依据。
 */
export async function measureIdleFrameInterval(page: Page, sampleMs = 600): Promise<number | null> {
  return page.evaluate(async duration => {
    const intervals: number[] = []
    let last = performance.now()
    const deadline = last + duration
    await new Promise<void>(resolve => {
      const tick = (now: number) => {
        intervals.push(now - last)
        last = now
        if (now >= deadline) resolve()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    if (intervals.length < 5) return null
    const sorted = [...intervals].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }, sampleMs)
}

export function summarizeFrameProbe(
  probe: { frames: number[]; longTasks: number[]; longTaskSupported: boolean } | null,
  idleIntervalMs: number | null = null,
) {
  const frames = probe?.frames ?? []
  const sorted = [...frames].sort((a, b) => a - b)
  const percentile = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null
  const budget = idleIntervalMs && idleIntervalMs > 0 ? idleIntervalMs : null
  return {
    sampleCount: frames.length,
    intervalMs: { p50: percentile(.5), p95: percentile(.95), max: sorted.at(-1) ?? null },
    frameBudgetMs: budget,
    refreshRateHz: budget ? Math.round(1000 / budget) : null,
    // 校准判据：超过 1.5T 才是掉帧候选；T 不可用时留 null，不退回硬编码 60Hz 下结论
    over1_5xBudgetRatio: budget && frames.length ? frames.filter(frame => frame > budget * 1.5).length / frames.length : null,
    // 保留 F0 原始 60Hz 参照，便于与既有报告逐项对照，不作为当前判据
    over1_5x16_7Ratio: frames.length ? frames.filter(frame => frame > 25.05).length / frames.length : null,
    longTasks: probe?.longTasks ?? [],
    longTaskSupported: probe?.longTaskSupported ?? false,
  }
}

/** CDP 渲染成本窗口：用来区分掉帧是布局/样式重算主导还是脚本主导（F3.1 取证）。 */
const CDP_METRIC_NAMES = [
  'TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration',
  'LayoutCount', 'RecalcStyleCount', 'JSHeapUsedSize', 'Nodes',
] as const

export type CdpMetricWindow = {
  taskDurationMs: number
  scriptDurationMs: number
  layoutDurationMs: number
  recalcStyleDurationMs: number
  layoutCount: number
  recalcStyleCount: number
  jsHeapUsedSizeMb: number
  nodes: number
  thumbRequests: number
  /** 布局+样式重算占任务时长的比例；越高越说明代价在渲染而非脚本 */
  renderShareOfTask: number | null
}

export async function createCdpMetricWindow(page: Page): Promise<{ stop: () => Promise<CdpMetricWindow | null> }> {
  const session = await page.context().newCDPSession(page).catch(() => null)
  if (!session) return { stop: async () => null }
  try {
    await session.send('Performance.enable')
  } catch {
    await session.detach().catch(() => undefined)
    return { stop: async () => null }
  }
  const read = async (): Promise<Record<string, number>> => {
    const { metrics } = await session.send('Performance.getMetrics')
    const map: Record<string, number> = {}
    for (const metric of metrics) map[metric.name] = metric.value
    return map
  }
  const before = await read()
  let thumbRequests = 0
  const onRequest = (request: { url: () => string }) => {
    if (/\/scene-showcase\/thumbs\//.test(request.url())) thumbRequests += 1
  }
  page.on('request', onRequest)
  return {
    async stop() {
      const after = await read()
      page.off('request', onRequest)
      await session.detach().catch(() => undefined)
      const delta = (name: string) => (after[name] ?? 0) - (before[name] ?? 0)
      const layout = delta('LayoutDuration') * 1000
      const recalc = delta('RecalcStyleDuration') * 1000
      const task = delta('TaskDuration') * 1000
      return {
        taskDurationMs: task,
        scriptDurationMs: delta('ScriptDuration') * 1000,
        layoutDurationMs: layout,
        recalcStyleDurationMs: recalc,
        layoutCount: delta('LayoutCount'),
        recalcStyleCount: delta('RecalcStyleCount'),
        jsHeapUsedSizeMb: Math.round((after.JSHeapUsedSize ?? 0) / 1048576),
        nodes: after.Nodes ?? 0,
        thumbRequests,
        renderShareOfTask: task > 0 ? (layout + recalc) / task : null,
      }
    },
  }
}

