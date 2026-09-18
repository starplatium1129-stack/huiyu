import { expect, type Page } from '@playwright/test'
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
}

/** Measure after Playwright has scrolled the real trigger into view, not before. */
export async function previewRoundTrip(page: Page, keyboard = false) {
  const trigger = page.locator('.artwork-button').first()
  await trigger.scrollIntoViewIfNeeded()
  await trigger.focus()
  const before = await page.evaluate(() => scrollY)
  const openedAt = await page.evaluate(() => performance.now())
  if (keyboard) await trigger.press('Enter')
  else await trigger.click()
  const viewer = page.locator('.art-viewer.open')
  await expect(viewer).toBeVisible()
  await expect(viewer).toHaveCSS('transform', 'none')
  await expect(viewer).not.toHaveAttribute('inert')
  if (keyboard) await page.keyboard.press('Escape')
  else await viewer.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('.art-viewer')).toBeHidden()
  await expect(trigger).toBeFocused()
  await expect(page.locator('body')).not.toHaveClass(/overlay-open/)
  const after = await page.evaluate(() => ({ scrollY, at: performance.now() }))
  expect(Math.abs(after.scrollY - before)).toBeLessThanOrEqual(2)
  return { scrollBefore: before, scrollAfter: after.scrollY, scrollError: Math.abs(after.scrollY - before), openCloseMs: after.at - openedAt }
}
