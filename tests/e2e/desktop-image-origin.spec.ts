import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const nativeOrigin = 'http://tauri.localhost'

/** Bundled desktop UI and gateway are different origins. Do not add Origin via
 * extraHTTPHeaders: it must come from each image's actual crossorigin attribute. */
async function desktopPage(page: Page, gateway: string) {
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
      return route.fulfill({ headers, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="832" height="1216"><rect width="832" height="1216" fill="#746687"/><text x="80" y="160" fill="white" font-size="48">CROSS ORIGIN PHOTO</text></svg>' })
    }
    if (path === '/scene-showcase/manifest.json') return route.fulfill({ headers, json: { entries: [
      { id: 'sc036', title: '跨来源图片夹具', char: 'nene', type: 'scene', rating: 'All', image: 'images/sc036.jpg', thumb: 'thumbs/sc036.jpg' },
    ] } })
    if (path.startsWith('/api/')) return route.fulfill({ headers, json: { ok: true, online: false, models: [], tasks: [], jobs: [] } })
    if (path.startsWith('/data/')) return route.fulfill({ headers, json: {} })
    const file = resolve(root, `.${path}`)
    if (path.startsWith('/assets/') && file.startsWith(root + sep) && existsSync(file)) return route.fulfill({ headers, path: file })
    return route.fulfill({ status: 404, headers })
  })
  return { denied, imageModes }
}

for (const theme of ['dark', 'light']) {
  test(`desktop image transition only presents decoded CORS images ${theme}`, async ({ page, baseURL }, info) => {
    const requests = await desktopPage(page, baseURL!)
    await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
    await page.goto(`${nativeOrigin}/showcase`)
    const opener = page.locator('.sample-visual').first()
    await expect(opener).toHaveAttribute('aria-label', '查看 跨来源图片夹具 大图')
    await opener.scrollIntoViewIfNeeded()
    await expect(opener.locator('img')).toHaveCSS('opacity', '1')
    await expect(page.locator('.showcase-grid')).toHaveCSS('transform', 'none')
    const states = await opener.evaluate(button => new Promise<Array<{ width: number; cors: string | null }>>(resolve => {
      const samples: Array<{ width: number; cors: string | null }> = []
      ;(button as HTMLElement).focus({ preventScroll: true }); (button as HTMLElement).click()
      let frames = 0
      const sample = () => {
        const image = document.querySelector<HTMLImageElement>('[data-image-origin-proxy]')
        if (image) samples.push({ width: image.naturalWidth, cors: image.crossOrigin })
        if (++frames === 45) { resolve(samples); return }
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    }))
    expect(states.length).toBeGreaterThan(3)
    expect(states.every(state => state.width > 0 && state.cors === 'anonymous')).toBe(true)
    const dialog = page.locator('.showcase-viewer')
    await expect.poll(() => dialog.locator('.zoomable-img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
    await page.screenshot({ path: info.outputPath(`desktop-cors-${theme}.png`) })
    await page.getByRole('button', { name: '关闭大图', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('[data-image-origin-proxy]')).toHaveCount(0)
    expect(requests.denied).toEqual([])
    expect(requests.imageModes.every(request => request.origin === nativeOrigin)).toBe(true)
  })
}
