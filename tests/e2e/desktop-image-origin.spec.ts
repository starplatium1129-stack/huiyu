import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const nativeOrigin = 'http://tauri.localhost'

/** Bundled desktop UI and gateway are different origins. Do not add Origin via
 * extraHTTPHeaders: it must come from each image's actual crossorigin attribute. */
async function desktopPage(page: Page, gateway: string, longCatalog: boolean) {
  const root = resolve('.'), dist = resolve('dist')
  const denied: string[] = []
  const imageModes: Array<{ path: string; origin: string | undefined }> = []
  await page.context().grantPermissions(['local-network-access'], { origin: nativeOrigin })
  await page.addInitScript(({ gateway, nativeOrigin }) => {
    const host = window as unknown as { __TAURI__: unknown }
    host.__TAURI__ = {
      core: { invoke: async (command: string) => {
        if (command === 'desktop_bootstrap') return {
          protocolVersion: 1, windowRole: 'atelier', windowId: 'atelier', sourceProfileId: `profile-${'a'.repeat(64)}`,
          sourceOrigin: nativeOrigin, bundledUiAvailable: true, connection: 'ready',
          runtime: { protocolVersion: 1, ownership: 'managed', runtimeEpoch: 'cross-origin-fixture', origin: gateway, workspace: null },
        }
        if (command === 'window_zoom_get') return 1
        if (command === 'get_window_state') return { maximized: false, focused: true }
        return undefined
      } },
      event: { listen: async () => () => {} },
      window: { getCurrentWindow: () => ({ startDragging: async () => {} }) },
    }
  }, { gateway, nativeOrigin })
  await page.route(`${nativeOrigin}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname
    const base = pathname.startsWith('/assets/') ? root : dist
    const file = resolve(base, pathname === '/showcase' || pathname === '/' ? 'index.html' : `.${pathname}`)
    if (!file.startsWith(base + sep) || !existsSync(file)) return route.fulfill({ status: 404 })
    await route.fulfill({ path: file, headers: { 'Referrer-Policy': 'no-referrer' } })
  })
  await page.route(`${gateway}/**`, async route => {
    const path = new URL(route.request().url()).pathname
    const origin = (await route.request().allHeaders()).origin
    const headers = { 'Access-Control-Allow-Origin': nativeOrigin, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
    if (/^\/scene-showcase\/(images|thumbs)\//.test(path)) {
      imageModes.push({ path, origin })
      if (origin !== nativeOrigin) { denied.push(path); return route.fulfill({ status: 403, contentType: 'text/html', body: 'Local source required' }) }
      // Keep the original pending while the cached thumbnail performs its flight.
      // This also prevents a deliberately supported source-swap fallback from
      // making this request-policy regression depend on network timing.
      if (path.includes('/images/')) await new Promise(resolve => setTimeout(resolve, 350))
      return route.fulfill({ headers, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="832" height="1216"><rect width="832" height="1216" fill="#746687"/><text x="80" y="160" fill="white" font-size="48">CROSS ORIGIN PHOTO</text></svg>' })
    }
    if (path === '/scene-showcase/manifest.json') return route.fulfill({ headers, json: { entries: Array.from({ length: longCatalog ? 48 : 1 }, (_, index) => { const id = longCatalog ? `sc${String(index + 1).padStart(3, '0')}` : 'sc036'; return { id, title: id === 'sc036' ? '跨来源图片夹具' : `滚动夹具 ${id}`, char: 'nene', type: 'scene', rating: 'All', image: `images/${id}.jpg`, thumb: `thumbs/${id}.jpg` } }) } })
    if (path.startsWith('/api/')) return route.fulfill({ headers, json: { ok: true, online: false, models: [], tasks: [], jobs: [] } })
    if (path.startsWith('/data/')) return route.fulfill({ headers, json: {} })
    const file = resolve(root, `.${path}`)
    if (path.startsWith('/assets/') && file.startsWith(root + sep) && existsSync(file)) return route.fulfill({ headers, path: file })
    return route.fulfill({ status: 404, headers })
  })
  return { denied, imageModes }
}

for (const theme of ['dark', 'light']) {
  for (const longCatalog of [false, true]) {
  test(`desktop preview ${longCatalog ? 'keeps long-catalog scroll' : 'presents decoded CORS images'} ${theme}`, async ({ page, baseURL }, info) => {
    const requests = await desktopPage(page, baseURL!, longCatalog)
    await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
    await page.goto(`${nativeOrigin}/showcase`)
    await expect(page.locator('html')).toHaveClass(/aics-desktop-shell/)
    await expect(page.locator('.sample').first()).toBeVisible()
    const card = page.locator('.sample[data-sample-id="sc036"]')
    if (!await card.count()) await page.getByRole('button', { name: /加载更多/ }).evaluate(button => (button as HTMLButtonElement).click())
    const opener = card.locator('.sample-visual')
    await expect(opener).toHaveAttribute('aria-label', '查看 跨来源图片夹具 大图')
    await opener.scrollIntoViewIfNeeded()
    await expect(opener.locator('img')).toHaveCSS('opacity', '1')
    await expect(page.locator('.showcase-grid')).toHaveCSS('transform', 'none')
    const before = await page.evaluate(() => scrollY)
    if (longCatalog) expect(before).toBeGreaterThan(1000)
    const opening = await opener.evaluate(button => new Promise<{ states: Array<{ width: number; cors: string | null }>; positions: number[] }>(resolve => {
      const samples: Array<{ width: number; cors: string | null }> = [], positions: number[] = []
      ;(button as HTMLElement).focus({ preventScroll: true }); (button as HTMLElement).click()
      let frames = 0
      const sample = () => {
        const image = document.querySelector<HTMLImageElement>('[data-image-origin-proxy]')
        positions.push(scrollY)
        if (image) samples.push({ width: image.naturalWidth, cors: image.crossOrigin })
        if (++frames === 45) { resolve({ states: samples, positions }); return }
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    }))
    const { states } = opening
    expect(Math.max(...opening.positions.map(y => Math.abs(y - before)))).toBeLessThanOrEqual(1)
    if (!longCatalog) expect(states.length).toBeGreaterThan(3)
    expect(states.every(state => state.width > 0 && state.cors === 'anonymous')).toBe(true)
    const dialog = page.locator('.showcase-viewer')
    await expect.poll(() => dialog.locator('.zoomable-img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
    await page.screenshot({ path: info.outputPath(`desktop-cors-${theme}.png`) })
    const closing = await dialog.evaluate(element => new Promise<number[]>(resolve => {
      const positions: number[] = []; let closed = 0
      const sample = () => {
        positions.push(scrollY)
        if (!(element as HTMLDialogElement).open && ++closed === 5) { resolve(positions); return }
        requestAnimationFrame(sample)
      }
      ;(element.querySelector('#viewerClose') as HTMLButtonElement).click()
      requestAnimationFrame(sample)
    }))
    expect(Math.max(...closing.map(y => Math.abs(y - before)))).toBeLessThanOrEqual(1)
    await expect(dialog).toBeHidden()
    await expect(page.locator('[data-image-origin-proxy]')).toHaveCount(0)
    expect(requests.denied).toEqual([])
    expect(requests.imageModes.every(request => request.origin === nativeOrigin)).toBe(true)
  })
}

}
