import { expect, type Locator, type Page } from '@playwright/test'
import { installUiFluidityFixture } from './ui-fluidity-fixture'
import { clickNavPath } from './ui-fluidity-measure'

export type OfficeMode = 'full' | 'low' | 'reduce'
export const OFFICE_ROUTES = ['/prompt-builder', '/gallery', '/showcase', '/video-studio'] as const
export const OFFICE_FIXTURE = { id: '009-office-v1', galleryCount: 24, image: '832x1216 synthetic SVG', appearanceKey: 'atelier-desktop-appearance-v1' }

/** New isolated browser context only. No operator data, generator, or microphone. */
export async function prepareOffice(page: Page, theme: string, mode: OfficeMode) {
  const writes: string[] = []
  await page.route('**/api/**', async route => {
    const request = route.request()
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
      return route.abort('blockedbyclient')
    }
    return route.fallback()
  })
  await installUiFluidityFixture(page, false)
  // Keep model detection deterministic before taking the resource baseline.
  // The real isolated runtime probes otherwise finish between baseline and sample 10.
  await page.route('**/api/video/status*', route => route.fulfill({ json: {
    ok:true, online:false, pending:0, maxPending:2,
    models:[{ id:'minimax-h3', label:'MiniMax H3', family:'H3', tier:'本地', summary:'009 隔离视频界面夹具',
      executable:true, available:true, reason:'离线界面夹具', modes:['text','image','first-last-frame'], requirements:[], missing:[] }],
    qualities:[{ id:'standard', label:'标准', summary:'日常创作', sizes:{ landscape:'832 × 480', portrait:'480 × 832', square:'640 × 640' } }],
    defaults:{ modelId:'minimax-h3', aspectRatio:'landscape', duration:3, camera:'still', motion:'subtle', quality:'standard' },
    t8:{ available:false, reason:'隔离夹具不调用视频模型' },
  } }))
  await page.goto('/style')
  await expect(page.locator('main h1')).toBeVisible()
  await page.evaluate(async ({ theme, mode, fixture }) => {
    localStorage.setItem('aics_theme', theme)
    localStorage.setItem(fixture.appearanceKey, JSON.stringify({ theme, motion: mode === 'reduce' ? 'reduce' : 'full', reducedGlass: mode === 'low' }))
    const entries = Array.from({ length: fixture.galleryCount }, (_, index) => ({
      id: `office-009-${index}`, sceneTitle: `009 synthetic artwork ${index}`, character: 'nene',
      timestamp: 1700000000000 + index, width: 832, height: 1216,
      image_data: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="832" height="1216"><rect width="832" height="1216" fill="#554b68"/><text x="48" y="96" fill="white" font-size="32">009 FIXTURE ${index}</text></svg>`),
    }))
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('aics_kv_store', 1)
      open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains('kv')) open.result.createObjectStore('kv', { keyPath: 'key' }) }
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('kv', 'readwrite')
        tx.objectStore('kv').put({ key: 'aics_pb_history', value: entries })
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onabort = tx.onerror = () => { db.close(); reject(tx.error) }
      }
    })
  }, { theme, mode, fixture: OFFICE_FIXTURE })
  await page.goto('/gallery')
  await expect(page.locator('.artwork-button').first()).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await expect(page.locator('html')).toHaveAttribute('data-fluid-effects', mode === 'low' ? 'low' : 'full')
  return writes
}

export async function settledRoute(page: Page) {
  const root = page.locator('main > .route-view')
  await expect(root).toHaveCount(1)
  await expect(root).toBeVisible()
  await expect(root).not.toHaveAttribute('inert')
  await expect(root).toHaveCSS('transform', 'none')
  await expect(page.locator('body')).not.toHaveClass(/overlay-open/)
}
export async function visitOfficeRoute(page: Page, path: string) {
  await clickNavPath(page, path)
  await settledRoute(page)
  await expect(page.locator('main h1')).toBeVisible()
  if (path === '/video-studio') await expect(page.locator('.video-status-pill')).toHaveAttribute('data-state', 'offline')
}

/** Snapshot in capture phase, after automation scrolling but before Vue opens the surface. */
export async function armPreviewAnchor(trigger: Locator) {
  await trigger.evaluate(el => {
    el.addEventListener('click', () => {
      el.setAttribute('data-office-input-y', String(scrollY))
      el.setAttribute('data-office-input-at', String(performance.now()))
    }, { capture: true, once: true })
  })
}
export async function consumePreviewAnchor(trigger: Locator) {
  return trigger.evaluate(el => {
    const y = el.getAttribute('data-office-input-y'), at = el.getAttribute('data-office-input-at')
    el.removeAttribute('data-office-input-y'); el.removeAttribute('data-office-input-at')
    if (y === null || at === null) throw new Error('Preview activation was not observed')
    return { scrollY: Number(y), at: Number(at) }
  })
}

/** Measure after Playwright has scrolled the real trigger into view, not before. */
export async function previewRoundTrip(page: Page, keyboard = false) {
  const trigger = page.locator('.artwork-button').first()
  await trigger.scrollIntoViewIfNeeded()
  await trigger.focus()
  const preparedScrollY = await page.evaluate(() => scrollY)
  await armPreviewAnchor(trigger)
  if (keyboard) await trigger.press('Enter')
  else await trigger.click()
  const activation = await consumePreviewAnchor(trigger)
  const before = activation.scrollY
  const viewer = page.getByRole('dialog', { name: '作品观赏模式', exact: true, includeHidden: true })
  await expect(viewer).toBeVisible()
  await expect(viewer).toHaveCSS('transform', 'none')
  await expect(viewer).not.toHaveAttribute('inert')
  if (keyboard) await page.keyboard.press('Escape')
  else await viewer.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(viewer).toBeHidden()
  await expect(trigger).toBeFocused()
  await expect(page.locator('body')).not.toHaveClass(/overlay-open/)
  const after = await page.evaluate(() => ({ scrollY, at: performance.now() }))
  expect(Math.abs(after.scrollY - before), JSON.stringify({ preparedScrollY, atActivation: before, after: after.scrollY })).toBeLessThanOrEqual(2)
  return { preparedScrollY, scrollBefore: before, scrollAfter: after.scrollY, scrollError: Math.abs(after.scrollY - before), openCloseMs: after.at - activation.at }
}

/** Conservative on-art text bound: composite the real overlay on both black and
 * white. Separated foreground/background luminance intervals bound either text
 * polarity for any underlying image. No CSS is changed for the measurement. */
export function onArtTextContrast(element: Element) {
  const viewer = element.closest('.art-viewer')
  if (!viewer) throw new Error('Expected an artwork-viewer descendant')
  const layers: CSSStyleDeclaration[] = []
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.backgroundImage !== 'none' || Number(style.opacity) !== 1) throw new Error('Expected settled, flat overlay layers')
    layers.unshift(style)
    if (node === viewer) break
  }
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const luminance = () => [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
    const v = value / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4
  }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0)
  const samples = ['black', 'white'].map(base => {
    ctx.fillStyle = base; ctx.fillRect(0, 0, 1, 1)
    for (const style of layers) { ctx.fillStyle = style.backgroundColor; ctx.fillRect(0, 0, 1, 1) }
    const background = luminance()
    ctx.fillStyle = getComputedStyle(element).color; ctx.fillRect(0, 0, 1, 1)
    return { background, foreground: luminance() }
  })
  const foregroundLow = Math.min(...samples.map(sample => sample.foreground))
  const foregroundHigh = Math.max(...samples.map(sample => sample.foreground))
  const backgroundLow = Math.min(...samples.map(sample => sample.background))
  const backgroundHigh = Math.max(...samples.map(sample => sample.background))
  // Both themes are valid: bound light-on-dark and dark-on-light separately.
  // Overlapping luminance intervals cannot certify a contrast floor above 1.
  if (foregroundLow > backgroundHigh) return (foregroundLow + .05) / (backgroundHigh + .05)
  if (backgroundLow > foregroundHigh) return (backgroundLow + .05) / (foregroundHigh + .05)
  return 1
}
