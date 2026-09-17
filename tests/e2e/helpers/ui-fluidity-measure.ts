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

export function summarizeFrameProbe(probe: { frames: number[]; longTasks: number[]; longTaskSupported: boolean } | null) {
  const frames = probe?.frames ?? []
  const sorted = [...frames].sort((a, b) => a - b)
  const percentile = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null
  return {
    sampleCount: frames.length,
    intervalMs: { p50: percentile(.5), p95: percentile(.95), max: sorted.at(-1) ?? null },
    over1_5x16_7Ratio: frames.length ? frames.filter(frame => frame > 25.05).length / frames.length : null,
    longTasks: probe?.longTasks ?? [],
    longTaskSupported: probe?.longTaskSupported ?? false,
  }
}

