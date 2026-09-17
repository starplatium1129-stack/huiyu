import { test, expect, type Browser, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { installUiFluidityFixture, setUiFluidityMeasurement, UI_FLUIDITY_FIXTURE } from './helpers/ui-fluidity-fixture'
import {
  clickNavPath,
  createCdpMetricWindow,
  measureIdleFrameInterval,
  measureSpaNavigation,
  startFrameProbe,
  stopFrameProbe,
  summarizeFrameProbe,
  waitForPrimary,
  type CdpMetricWindow,
  type NavigationMeasurement,
  type UiFluidityEvent,
} from './helpers/ui-fluidity-measure'

const VIEWPORT = { width: 1440, height: 960 }
const REPORT_DIR = 'runtime/ui-fluidity-f0'
const ROUND_COUNT = Math.max(1, Number(process.env.AICS_FLUIDITY_ROUNDS || 3))
const SAMPLE_COUNT = Math.max(1, Number(process.env.AICS_FLUIDITY_SAMPLES || 20))

function target(page: Page, path: string, label: string) {
  const selectors: Record<string, string> = {
    '/': '.home-page .hero-title',
    '/scene-explorer': '.scene-grid .stagger-item',
    '/prompt-builder': '.pb .gen-bar',
    '/gallery': '.gallery-page .gallery-toolbar',
    '/showcase': '.showcase-page .showcase-grid .sample',
    '/style': 'main h1',
  }
  return { path, label, ready: page.locator(selectors[path] || 'main h1').first() }
}

async function enter(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' })
  await waitForPrimary(page, target(page, path, path).ready)
}

async function rawSpaNavigation(page: Page, path: string): Promise<number> {
  const started = await page.evaluate(() => performance.now())
  await clickNavPath(page, path)
  await waitForPrimary(page, target(page, path, path).ready)
  return (await page.evaluate(() => performance.now())) - started
}

async function runS01(page: Page): Promise<{ navigation: NavigationMeasurement[] }> {
  await enter(page, '/')
  return {
    navigation: [
      await measureSpaNavigation(page, target(page, '/scene-explorer', 'S01 首页 → 场景库')),
      await measureSpaNavigation(page, target(page, '/prompt-builder', 'S01 场景库 → 导演台')),
    ],
  }
}

async function runS02(page: Page): Promise<{ navigation: NavigationMeasurement[] }> {
  await enter(page, '/prompt-builder')
  return {
    navigation: [
      await measureSpaNavigation(page, target(page, '/gallery', 'S02 导演台 → 作品册')),
      await measureSpaNavigation(page, target(page, '/prompt-builder', 'S02 作品册 → 导演台')),
    ],
  }
}

async function runS03(page: Page) {
  await enter(page, '/scene-explorer')
  // 先取静止前台的有效间隔 T，掉帧判据按 1.5T 校准，避免 60Hz 阈值套在 120Hz 前台上
  const idleIntervalMs = await measureIdleFrameInterval(page)
  // CDP 渲染成本窗口：同一时间窗内区分布局/样式重算与脚本代价（F3.1 取证）
  const cdpWindow = await createCdpMetricWindow(page)
  await startFrameProbe(page)
  await page.mouse.wheel(0, 2600)
  await page.locator('#sceneSearch').fill('F0 固定场景 2')
  await expect(page.locator('.scene-count')).toContainText('已显示')
  await page.waitForTimeout(220)
  await page.locator('#sceneSearch').fill('')
  await page.waitForTimeout(220)
  const probe = summarizeFrameProbe(await stopFrameProbe(page), idleIntervalMs)
  const cdp = await cdpWindow.stop()
  const state = await page.evaluate(() => ({
    scrollY: window.scrollY,
    documentHeight: document.documentElement.scrollHeight,
    cardCount: document.querySelectorAll('[data-scene-id]').length,
    inputValue: (document.querySelector('#sceneSearch') as HTMLInputElement | null)?.value || '',
  }))
  return { ...state, idleIntervalMs, probe, cdp }
}

async function runS04(page: Page) {
  await enter(page, '/showcase')
  const cards = page.locator('.showcase-grid .sample')
  await expect(cards.first()).toBeVisible()
  await expect.poll(() => cards.count()).toBeGreaterThan(0)
  await page.evaluate(() => window.scrollTo(0, 420))
  const before = await page.evaluate(() => ({ scrollY: window.scrollY }))
  await cards.first().locator('.sample-visual').click()
  const dialog = page.locator('dialog.showcase-viewer[open]')
  await expect(dialog).toBeVisible()
  const opened = await page.evaluate(() => performance.now())
  await dialog.locator('#viewerClose').click()
  await expect(page.locator('dialog.showcase-viewer[open]')).toHaveCount(0)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const after = await page.evaluate(() => ({
    scrollY: window.scrollY,
    active: document.activeElement instanceof HTMLElement ? document.activeElement.className : '',
  }))
  return {
    openToCloseMs: await page.evaluate((openedAt) => performance.now() - openedAt, opened),
    scrollBefore: before.scrollY,
    scrollAfter: after.scrollY,
    scrollError: Math.abs(before.scrollY - after.scrollY),
    activeElementClass: after.active,
  }
}

async function runS05(page: Page) {
  await enter(page, '/style')
  const before = await page.evaluate(() => performance.now())
  const beforeEvents = await page.evaluate(() => {
    const state = (window as Window & { __AICS_UI_FLUIDITY__?: { events?: UiFluidityEvent[] } }).__AICS_UI_FLUIDITY__
    return state?.events?.length || 0
  })
  for (const path of ['/scene-explorer', '/showcase', '/prompt-builder']) {
    const link = page.locator(`nav.nav a[href="${path}"]`).first()
    await expect(link).toBeVisible()
    await link.evaluate(element => (element as HTMLAnchorElement).click())
  }
  await page.waitForURL(/\/prompt-builder$/)
  await waitForPrimary(page, target(page, '/prompt-builder', 'S05 final').ready)
  const finalPath = new URL(page.url()).pathname
  await page.evaluate(path => {
    const state = (window as Window & { __AICS_UI_FLUIDITY__?: { mark?: (phase: UiFluidityEvent['phase'], path?: string) => void } }).__AICS_UI_FLUIDITY__
    state?.mark?.('primary-ready', path)
  }, `${finalPath}`)
  await page.waitForTimeout(260)
  const allEvents = await page.evaluate(() => {
    const state = (window as Window & { __AICS_UI_FLUIDITY__?: { events?: UiFluidityEvent[] } }).__AICS_UI_FLUIDITY__
    return state?.events ? [...state.events] : []
  })
  const events = allEvents.slice(beforeEvents)
  return {
    sequence: ['/scene-explorer', '/showcase', '/prompt-builder'],
    finalPath,
    clickSequenceMs: (await page.evaluate(() => performance.now())) - before,
    cancelledCount: events.filter(event => event.phase === 'cancelled').length,
    eventPhases: events.map(event => ({ id: event.id, phase: event.phase, path: event.path, at: event.at })),
  }
}

/**
 * S03 窗口分解 + 图片归因。
 *
 * 同一固定夹具下跑四种变体，用来把 S03 的掉帧候选归因到具体动作：
 *   scroll-only(svg)      只滚动，不输入筛选
 *   scroll-only(micro)    同上，但缩略图换成 1×1 PNG（请求数与 DOM 结构不变，仅解码成本≈0）
 *   filter-only(svg)      只输入/清空筛选，不滚动
 *   full(svg)             与 S03 场景一致的完整序列
 * 浏览器不提供 <50ms 帧的归因 API（LoAF 只覆盖 >50ms），因此用受控实验分解而不是靠 profiler 猜测。
 */
async function runS03DecompositionProbe(browser: Browser) {
  const variants = [
    { label: 'scroll-only(svg)', wheel: true, filter: false, thumbFormat: 'svg' as const, lowGlass: false },
    { label: 'scroll-only(micro)', wheel: true, filter: false, thumbFormat: 'micro' as const, lowGlass: false },
    { label: 'filter-only(svg)', wheel: false, filter: true, thumbFormat: 'svg' as const, lowGlass: false },
    // 补全 2×2：筛选会销毁/重建 24 张卡片，重建即重新解码；用零解码对照判断这份代价是否来自图片
    { label: 'filter-only(micro)', wheel: false, filter: true, thumbFormat: 'micro' as const, lowGlass: false },
    { label: 'full(svg)', wheel: true, filter: true, thumbFormat: 'svg' as const, lowGlass: false },
    { label: 'full(micro)', wheel: true, filter: true, thumbFormat: 'micro' as const, lowGlass: false },
    // 决定性对照：查询词匹配全部固定场景，筛选/排序/防抖/写 URL 全部照跑，但列表内容不变
    // （24 张卡片不销毁不重建）。若掉帧消失 → 代价来自列表增删；若仍在 → 来自同一批卡片的重渲染。
    { label: 'full(wide-query)', wheel: true, filter: true, filterQuery: 'F0', thumbFormat: 'svg' as const, lowGlass: false },
    // 同上窄查询，但注入 CSS 关掉 .sc-thumb 的 blur 渐变过渡：验证"重建时 24 张卡同时跑 filter 动画"
    // （filter 非合成器属性，每帧重绘）是否就是叠加掉帧的机制。
    { label: 'full(no-thumb-blur)', wheel: true, filter: true, thumbFormat: 'svg' as const, lowGlass: false, noThumbBlur: true },
    // 同样的 full 序列，但关掉吸顶工具栏/导航的 backdrop-filter（仓库自带降级开关）：
    // 用来验证「滚动 + 内容重绘叠加才掉帧」是否来自玻璃模糊反复重光栅化。
    { label: 'full(low-glass)', wheel: true, filter: true, thumbFormat: 'svg' as const, lowGlass: true },
  ]
  const runs: Array<Record<string, unknown>> = []
  for (const variant of variants) {
    const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: 'no-preference', colorScheme: 'dark' })
    const page = await context.newPage()
    try {
      await installUiFluidityFixture(page, true, { thumbFormat: variant.thumbFormat })
      await enter(page, '/scene-explorer')
      if (variant.lowGlass) {
        await page.evaluate(() => { document.documentElement.dataset.reducedGlass = 'true' })
        await page.waitForTimeout(120)
      }
      if (variant.noThumbBlur) {
        await page.addStyleTag({ content: '.sc-thumb { filter:none !important; transition:none !important; }' })
        await page.waitForTimeout(120)
      }
      const idleIntervalMs = await measureIdleFrameInterval(page)
      const cdpWindow = await createCdpMetricWindow(page)
      await startFrameProbe(page)
      if (variant.wheel) await page.mouse.wheel(0, 2600)
      if (variant.filter) {
        await page.locator('#sceneSearch').fill(variant.filterQuery ?? 'F0 固定场景 2')
        await expect(page.locator('.scene-count')).toContainText('已显示')
        await page.waitForTimeout(220)
        await page.locator('#sceneSearch').fill('')
        await page.waitForTimeout(220)
      } else {
        await page.waitForTimeout(440)
      }
      const probe = summarizeFrameProbe(await stopFrameProbe(page), idleIntervalMs)
      const cdp = await cdpWindow.stop()
      // 自证：确认降级开关与注入样式在窗口结束时仍然生效，避免"开关没生效"被误读成"不是原因"
      const glass = await page.evaluate(() => {
        const thumb = document.querySelector('.sc-thumb')
        return {
          reducedGlass: document.documentElement.dataset.reducedGlass ?? null,
          toolbarBackdrop: getComputedStyle(document.querySelector('.scene-toolbar') as Element).backdropFilter,
          thumbFilter: thumb ? getComputedStyle(thumb).filter : null,
          thumbTransition: thumb ? getComputedStyle(thumb).transitionProperty : null,
        }
      })
      // 自证：记录卡片数与文档高度，确认 wide-query 变体确实没有改变列表内容
      const layout = await page.evaluate(() => ({
        cardCount: document.querySelectorAll('[data-scene-id]').length,
        documentHeight: document.documentElement.scrollHeight,
        scrollY: window.scrollY,
      }))
      runs.push({ ...variant, idleIntervalMs, probe, cdp, glass, layout })
    } finally {
      await context.close()
    }
  }
  const pick = (label: string) => runs.find(run => run.label === label) as
    { probe: ReturnType<typeof summarizeFrameProbe>; cdp: CdpMetricWindow | null } | undefined
  const svg = pick('scroll-only(svg)')
  const micro = pick('scroll-only(micro)')
  const filterOnly = pick('filter-only(svg)')
  const full = pick('full(svg)')
  const task = (run: typeof svg) => run?.cdp?.taskDurationMs ?? null
  return {
    runs,
    attribution: {
      imageCostMs: svg?.cdp && micro?.cdp ? Number((svg.cdp.taskDurationMs - micro.cdp.taskDurationMs).toFixed(2)) : null,
      imageCostScrollOnlyMs: svg?.cdp && micro?.cdp ? Number((svg.cdp.taskDurationMs - micro.cdp.taskDurationMs).toFixed(2)) : null,
      imageCostFilterOnlyMs: pick('filter-only(svg)')?.cdp && pick('filter-only(micro)')?.cdp
        ? Number((pick('filter-only(svg)')!.cdp!.taskDurationMs - pick('filter-only(micro)')!.cdp!.taskDurationMs).toFixed(2))
        : null,
      imageCostFullMs: full?.cdp && pick('full(micro)')?.cdp
        ? Number((full.cdp.taskDurationMs - pick('full(micro)')!.cdp!.taskDurationMs).toFixed(2))
        : null,
      scrollOnlyTaskMs: task(svg),
      filterOnlyTaskMs: task(filterOnly),
      fullTaskMs: task(full),
      fullLowGlassTaskMs: task(pick('full(low-glass)')),
      fullP95FrameMs: full?.probe.intervalMs.p95 ?? null,
      fullMicroP95FrameMs: pick('full(micro)')?.probe.intervalMs.p95 ?? null,
      fullLowGlassP95FrameMs: pick('full(low-glass)')?.probe.intervalMs.p95 ?? null,
      interpretation: 'imageCost*Ms = 零解码对照与默认 SVG 的 task 差（请求数与 DOM 结构相同）；full 与 full(low-glass)/full(micro) 的对比分别验证玻璃模糊与图片解码是否为叠加掉帧来源',
    },
  }
}

async function runMeasurementOverhead(browser: Browser) {
  const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: 'no-preference', colorScheme: 'dark' })
  const page = await context.newPage()
  await installUiFluidityFixture(page, true)
  const records: Array<{ iteration: number; enabledMs: number; disabledMs: number }> = []
  try {
    await enter(page, '/style')
    for (let iteration = 0; iteration < 5; iteration++) {
      await setUiFluidityMeasurement(page, false)
      const disabledMs = await rawSpaNavigation(page, '/scene-explorer')
      await rawSpaNavigation(page, '/style')
      await setUiFluidityMeasurement(page, true)
      const enabledMs = await rawSpaNavigation(page, '/scene-explorer')
      await rawSpaNavigation(page, '/style')
      records.push({ iteration, enabledMs, disabledMs })
    }
  } finally {
    await context.close()
  }
  const deltas = records.map(record => record.enabledMs - record.disabledMs)
  return {
    records,
    deltaMs: deltas,
    medianDeltaMs: deltas.slice().sort((a, b) => a - b)[Math.floor(deltas.length / 2)] ?? null,
  }
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

/** 每轮采样实测的静止前台有效间隔 T 的中位数；显示刷新率由此反推，不猜。 */
function medianIdleInterval(scroll: Array<{ idleIntervalMs?: number | null }>): number | null {
  const values = scroll.map(sample => sample.idleIntervalMs).filter((value): value is number => typeof value === 'number' && value > 0)
  if (!values.length) return null
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function summarizeNavigation(samples: NavigationMeasurement[]) {
  const groups = new Map<string, NavigationMeasurement[]>()
  for (const sample of samples) groups.set(sample.label, [...(groups.get(sample.label) || []), sample])
  return [...groups.entries()].map(([label, entries]) => ({
    label,
    sampleCount: entries.length,
    clickToPrimaryMs: {
      p50: percentile(entries.map(entry => entry.clickToPrimaryMs), .5),
      p95: percentile(entries.map(entry => entry.clickToPrimaryMs), .95),
      max: Math.max(...entries.map(entry => entry.clickToPrimaryMs)),
    },
    intentToPrimaryMs: {
      p50: percentile(entries.flatMap(entry => entry.intentToPrimaryMs === null ? [] : [entry.intentToPrimaryMs]), .5),
      p95: percentile(entries.flatMap(entry => entry.intentToPrimaryMs === null ? [] : [entry.intentToPrimaryMs]), .95),
    },
    settledSamples: entries.filter(entry => entry.intentToSettledMs !== null).length,
    cancelledSamples: entries.filter(entry => entry.cancelled).length,
  }))
}

function buildIssueList(
  navigation: NavigationMeasurement[],
  scroll: Array<{ probe: ReturnType<typeof summarizeFrameProbe>; cdp?: CdpMetricWindow | null; traced?: boolean }>,
  rapid: Array<{ cancelledCount: number }>,
  preview: Array<{ scrollError: number }>,
) {
  const issues: Array<Record<string, unknown>> = []
  const navigationSummary = summarizeNavigation(navigation)
  for (const group of navigationSummary) {
    if (group.intentToPrimaryMs.p95 !== null && group.intentToPrimaryMs.p95 > 300) {
      issues.push({
        status: 'investigate',
        scenario: group.label,
        symptom: '导航意图到主要内容就绪 p95 超过 F0 初始 300ms 目标',
        evidence: group.intentToPrimaryMs,
        possibleCauses: ['模块求值或挂载', '数据解析/计算', '图片解码或纹理上传', '布局/绘制阻塞'],
        excludedByFixture: ['真实生成请求', '真实麦克风', '生产作品库', '外部网络样张'],
        nextBatch: 'F1/F2（先按 trace 与原始时序拆分）',
      })
    }
  }
  // 判据优先用实测 T 校准；只有 T 缺失时才退回 F0 的 60Hz 参照，并在证据里标明来源
  // 带 tracing 的样本单列：trace 的 snapshots/screenshots 会自己抬高主线程与节点数
  const scrollClean = scroll.filter(sample => !sample.traced)
  const scrollRatio = (sample: { probe: ReturnType<typeof summarizeFrameProbe> }) => sample.probe.frameBudgetMs
    ? sample.probe.over1_5xBudgetRatio
    : sample.probe.over1_5x16_7Ratio
  const scrollCandidates = scrollClean.filter(sample => (scrollRatio(sample) ?? 0) > .01)
  if (scrollCandidates.length) {
    const ratios = scrollCandidates.map(sample => scrollRatio(sample)!).sort((a, b) => a - b)
    const legacyRatios = scrollCandidates.map(sample => sample.probe.over1_5x16_7Ratio ?? 0).sort((a, b) => a - b)
    const budgets = scrollClean.map(sample => sample.probe.frameBudgetMs).filter((value): value is number => value !== null)
    const frameP95 = scrollCandidates.map(sample => sample.probe.intervalMs.p95).filter((value): value is number => value !== null)
    issues.push({
      status: 'investigate',
      scenario: 'S03',
      symptom: '滚动窗口存在超过 1.5× 实测静止间隔 T 的掉帧候选',
      evidence: {
        totalSamples: scrollClean.length,
        tracedExcludedSamples: scroll.length - scrollClean.length,
        candidateSamples: scrollCandidates.length,
        candidateRate: scrollCandidates.length / scrollClean.length,
        criterion: 'rAF interval > 1.5 × measured idle foreground interval T',
        calibratedSamples: budgets.length,
        frameBudgetMs: budgets.length
          ? { p50: percentile(budgets, .5), min: Math.min(...budgets), max: Math.max(...budgets) }
          : null,
        refreshRateHz: budgets.length ? Math.round(1000 / (percentile(budgets, .5) as number)) : null,
        over1_5xBudgetRatio: {
          p50: ratios[Math.floor(ratios.length * .5)],
          p95: ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * .95))],
          max: ratios.at(-1),
        },
        legacyOver1_5x16_7Ratio: {
          p50: legacyRatios[Math.floor(legacyRatios.length * .5)],
          p95: legacyRatios[Math.min(legacyRatios.length - 1, Math.floor(legacyRatios.length * .95))],
          max: legacyRatios.at(-1),
        },
        frameIntervalP95Ms: {
          p50: percentile(frameP95, .5),
          p95: percentile(frameP95, .95),
          max: Math.max(...frameP95),
        },
      },
      possibleCauses: ['列表响应式更新', '布局/绘制交错', '图片解码尖峰'],
      excludedByFixture: ['生成任务', '媒体输入', '生产图库'],
      renderCost: (() => {
        const samples = scrollClean.map(sample => sample.cdp).filter((value): value is CdpMetricWindow => Boolean(value))
        if (!samples.length) return { status: 'unavailable', reason: 'CDP Performance domain unavailable in this browser' }
        const pick = (key: keyof CdpMetricWindow) => samples.map(sample => Number(sample[key] ?? 0)).sort((a, b) => a - b)
        const shares = samples.map(sample => sample.renderShareOfTask).filter((value): value is number => value !== null).sort((a, b) => a - b)
        const at = (values: number[], p: number) => values[Math.min(values.length - 1, Math.floor(values.length * p))]
        return {
          status: 'measured',
          samples: samples.length,
          windowMs: 'S03 同窗口（滚动 2600px + 两次筛选输入）',
          totalWindowTaskMs: { p50: at(pick('taskDurationMs'), .5), p95: at(pick('taskDurationMs'), .95) },
          scriptMs: { p50: at(pick('scriptDurationMs'), .5), p95: at(pick('scriptDurationMs'), .95) },
          layoutMs: { p50: at(pick('layoutDurationMs'), .5), p95: at(pick('layoutDurationMs'), .95) },
          recalcStyleMs: { p50: at(pick('recalcStyleDurationMs'), .5), p95: at(pick('recalcStyleDurationMs'), .95) },
          layoutCount: { p50: at(pick('layoutCount'), .5), p95: at(pick('layoutCount'), .95) },
          recalcStyleCount: { p50: at(pick('recalcStyleCount'), .5), p95: at(pick('recalcStyleCount'), .95) },
          renderShareOfTask: { p50: at(shares, .5), p95: at(shares, .95) },
          thumbRequests: { p50: at(pick('thumbRequests'), .5), max: Math.max(...pick('thumbRequests')) },
        }
      })(),
      nextBatch: 'F3（结合代表性 trace）',
    })
  }
  const previewDrift = preview.filter(sample => sample.scrollError > 2)
  if (previewDrift.length) {
    issues.push({
      status: 'investigate',
      scenario: 'S04',
      symptom: '预览关闭后部分样本未恢复到原滚动锚点（误差 > 2 CSS px）',
      evidence: {
        totalSamples: preview.length,
        driftSamples: previewDrift.length,
        driftRate: previewDrift.length / preview.length,
        maxErrorCssPx: Math.max(...preview.map(sample => sample.scrollError)),
      },
      possibleCauses: ['dialog/overflow 锁与 window scroll 恢复竞态', '图片/布局高度在关闭时变化'],
      excludedByFixture: ['生产作品库', '真实 Blob 图片生命周期', '真实生成任务'],
      nextBatch: 'F2/F4（回放焦点、滚动锁与内容就绪时序）',
    })
  }
  const rapidCancelled = rapid.reduce((sum, sample) => sum + sample.cancelledCount, 0)
  if (rapid.length && rapidCancelled === 0) {
    issues.push({
      status: 'not-reproduced',
      scenario: 'S05',
      symptom: '固定夹具下未采到取消事件，无法证明连续导航已覆盖慢模块竞态',
      evidence: { samples: rapid.length, cancelledCount: rapidCancelled },
      possibleCauses: ['当前办公机缓存使路由过快', '需在慢 chunk/慢数据响应夹具下复测'],
      excludedByFixture: ['不把“无取消事件”解释为已修复'],
      nextBatch: 'F1（补受控慢响应/真实 trace）',
    })
  }
  if (!issues.length) issues.push({ status: 'no-threshold-hit', scenario: 'F0', symptom: '当前固定夹具未超过初始筛选阈值', nextBatch: 'F1，保留原始数据与 trace' })
  return issues
}

function sourceCommit(): string {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { return 'unknown' }
}

function workingTreeFiles(): string[] {
  try {
    return execFileSync('git', ['status', '--short'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
  } catch { return [] }
}

function writeReport(report: Record<string, unknown>): void {
  mkdirSync(`${REPORT_DIR}/traces`, { recursive: true })
  writeFileSync(`${REPORT_DIR}/ui-fluidity-f0.json`, JSON.stringify(report, null, 2))
  const summary = report.summary as { navigation?: unknown; issues?: unknown }
  writeFileSync(`${REPORT_DIR}/ui-fluidity-f0.md`, [
    '# 009 F0 · UI 流畅度基线',
    '',
    `- source: ${sourceCommit()}`,
    `- fixture: ${UI_FLUIDITY_FIXTURE.id}`,
    `- samples: ${ROUND_COUNT} rounds × ${SAMPLE_COUNT} samples`,
    '- S06–S08: deferred（需要文档策略、真实任务/Live2D/后台恢复与目标 Windows 环境）',
    '',
    '## 导航汇总',
    '',
    '```json',
    JSON.stringify(summary.navigation || [], null, 2),
    '```',
    '',
    '## 问题清单',
    '',
    '```json',
    JSON.stringify(summary.issues || [], null, 2),
    '```',
    '',
    '原始时序、帧样本与代表性 trace 见同目录 JSON 与 `traces/`。',
    '',
  ].join('\n'))
}

test('009 F0 fixed-fixture fluidity baseline', async ({ browser }) => {
  test.setTimeout(15 * 60 * 1000)
  expect(existsSync('dist/index.html')).toBe(true)
  const navigation: NavigationMeasurement[] = []
  const scroll: Array<{ probe: ReturnType<typeof summarizeFrameProbe>; idleIntervalMs?: number | null; cdp?: CdpMetricWindow | null; traced?: boolean }> = []
  const rapid: Array<Record<string, unknown>> = []
  const preview: Array<{ scrollError: number }> = []
  const scenarios: Array<Record<string, unknown>> = []
  let traceWritten = false
  mkdirSync(`${REPORT_DIR}/traces`, { recursive: true })

  for (let round = 0; round < ROUND_COUNT; round++) {
    for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
      const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: 'no-preference', colorScheme: 'dark' })
      const page = await context.newPage()
      const shouldTrace = !traceWritten
      if (shouldTrace) {
        await context.tracing.start({ screenshots: true, snapshots: true, title: `009 F0 representative r${round}s${sample}` })
        traceWritten = true
      }
      await installUiFluidityFixture(page, true)
      try {
        const s01 = await runS01(page)
        navigation.push(...s01.navigation)
        scenarios.push({ round, sample, id: 'S01', ...s01 })

        const s02 = await runS02(page)
        navigation.push(...s02.navigation)
        scenarios.push({ round, sample, id: 'S02', ...s02 })

        const s03 = await runS03(page)
        // tracing 会显著抬高主线程与 DOM 节点数（实测 task 324ms vs 213ms、nodes 22522 vs 9747），
        // 该样本单列，不混入聚合，避免「诊断本身造成掉帧」（计划 F0.6）
        scroll.push({ ...s03, traced: shouldTrace })
        scenarios.push({ round, sample, id: 'S03', ...s03 })

        const s04 = await runS04(page)
        preview.push({ scrollError: s04.scrollError })
        scenarios.push({ round, sample, id: 'S04', ...s04 })

        const s05 = await runS05(page)
        rapid.push(s05)
        scenarios.push({ round, sample, id: 'S05', ...s05 })
      } finally {
        if (shouldTrace) {
          await context.tracing.stop({ path: `${REPORT_DIR}/traces/representative-r${round}s${sample}.zip` })
        }
        await context.close()
      }
    }
  }

  const overhead = process.env.AICS_FLUIDITY_SKIP_OVERHEAD === '1' ? { skipped: true } : await runMeasurementOverhead(browser)
  const s03Decomposition = process.env.AICS_FLUIDITY_SKIP_DECOMPOSITION_PROBE === '1' ? { skipped: true } : await runS03DecompositionProbe(browser)
  const report = {
    schema: 'aics.ui-fluidity.f0.v1',
    plan: '009',
    batch: 'F0',
    generatedAt: new Date().toISOString(),
    source: {
      commit: sourceCommit(),
      branch: process.env.GITHUB_REF_NAME || 'local',
      workingTree: { dirty: workingTreeFiles().length > 0, files: workingTreeFiles() },
    },
    build: {
      distPresent: existsSync('dist/index.html'),
      distMtime: existsSync('dist/index.html') ? statSync('dist/index.html').mtime.toISOString() : null,
    },
    runner: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      browser: browser.browserType().name(),
      browserVersion: browser.version(),
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      motion: 'no-preference',
      // 刷新率与帧预算来自实测静止间隔，未知时为 null，不假设 60Hz
      display: {
        measuredIdleIntervalMs: medianIdleInterval(scroll as Array<{ idleIntervalMs?: number | null }>),
        refreshRateHz: medianIdleInterval(scroll as Array<{ idleIntervalMs?: number | null }>) !== null
          ? Math.round(1000 / (medianIdleInterval(scroll as Array<{ idleIntervalMs?: number | null }>) as number))
          : null,
      },
      workers: 1,
      command: 'npm run test:e2e:performance',
      config: 'playwright.performance.config.ts',
      productionNetwork: 'fixture-intercepted data/showcase/status; no generation or microphone',
    },
    fixture: UI_FLUIDITY_FIXTURE,
    measurement: {
      enabledBy: 'window.__AICS_UI_FLUIDITY__.enabled',
      phases: ['intent', 'feedback-committed', 'shell-ready', 'primary-ready', 'settled', 'cancelled'],
      budgets: { inputFeedbackP95Ms: 100, warmPrimaryReadyP95Ms: 300, frameInterval60HzMs: 16.7, longTaskMs: 50, dropCandidateRatio: .01 },
      frameDropCriterion: 'rAF interval > 1.5 × 同轮实测静止前台间隔 T；frameInterval60HzMs 仅作与 F0 原始报告的对照，不作为当前判据',
      sampling: { rounds: ROUND_COUNT, samplesPerScenario: SAMPLE_COUNT, percentile: 'nearest-rank from raw samples', tracedSamples: '单列，不混入 S03 的帧与渲染成本聚合' },
    },
    deferredScenarios: [
      { id: 'S06', reason: 'document-policy reload and task confirmation require separate controlled navigation environment' },
      { id: 'S07', reason: 'real generation/Live2D/voice load is explicitly outside this isolated fixture' },
      { id: 'S08', reason: 'background, minimize, sleep/resume and 20-round resource snapshots need target Windows validation' },
    ],
    scenarios,
    overhead,
    s03Decomposition,
    summary: {
      navigation: summarizeNavigation(navigation),
      scroll,
      rapid,
      preview,
      issues: buildIssueList(
        navigation,
        scroll,
        rapid as Array<{ cancelledCount: number }>,
        preview,
      ),
    },
  }
  writeReport(report)
  expect(existsSync(`${REPORT_DIR}/ui-fluidity-f0.json`)).toBe(true)
})
