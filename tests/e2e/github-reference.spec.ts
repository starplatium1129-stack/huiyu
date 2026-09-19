import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/creative/status', route => route.fulfill({ json: { ok: true, online: false, models: [], loras: [], styleLoras: [] } }))
  await page.route('**/api/generation/status', route => route.fulfill({ json: { ok: true, online: false, provider: null, webuiOnline: false, comfyFallbackOnline: false, pending: 0, maxPending: 4, capabilities: { basic: false, hires: false, faceDetailer: false, hiresUpscalers: [] }, checkpoint: '', samplers: [], schedulers: [], models: [], loras: [] } }))
})

async function galleryFixture(page: Page, theme: string) {
  await page.addInitScript(theme => {
    localStorage.setItem('aics_theme', theme)
    const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 1000
    const context = canvas.getContext('2d')!
    const gradient = context.createLinearGradient(0, 0, 1600, 1000)
    gradient.addColorStop(0, '#394c6d'); gradient.addColorStop(1, '#d8b98f')
    context.fillStyle = gradient; context.fillRect(0, 0, 1600, 1000)
    context.fillStyle = '#ffffff'; context.font = '64px sans-serif'; context.fillText('Gallery gesture fixture', 120, 180)
    localStorage.setItem('aics_pb_history', JSON.stringify(Array.from({ length: 180 }, (_, index) => ({
      id: index + 1, sceneTitle: `Gesture fixture ${index + 1}`, timestamp: 1000 + index,
      prompt: 'Neutral test fixture', image_id: 'gesture-fixture', width: 1600, height: 1000,
    }))))
    canvas.toBlob(blob => {
      const request = indexedDB.open('aics_image_store', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('images', { keyPath: 'id' })
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('images', 'readwrite')
        tx.objectStore('images').put({ id: 'gesture-fixture', blob, name: 'fixture.png', type: 'image/png', created_at: 1 })
        tx.oncomplete = () => { db.close(); Object.assign(window, { galleryFixtureReady: true }) }
      }
    })
    const live = new Set<string>()
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = blob => { const url = create(blob); live.add(url); return url }
    URL.revokeObjectURL = url => { live.delete(url); revoke(url) }
    Object.assign(window, { galleryLiveUrls: live })
  }, theme)
}

for (const theme of ['light', 'dark']) {
  test(`PhotoSwipe spike zoom, navigation, focus and resource lifecycle ${theme}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000)
    await galleryFixture(page, theme)
    await page.goto('/gallery')
    await page.waitForFunction(() => (window as unknown as { galleryFixtureReady?: boolean }).galleryFixtureReady === true)
    const opener = page.locator('.artwork-button').first()
    await expect(page.locator('.artwork')).toHaveCount(60)
    await opener.focus()
    const initialScroll = await page.evaluate(() => scrollY)
    await opener.click()
    await expect(page.locator('.zoomable-img')).toBeVisible()
    const oldTransform = await page.locator('.zoom-transform-layer').getAttribute('style')
    await page.locator('.zoomable-img').dblclick()
    await expect(page.locator('.zoom-transform-layer')).not.toHaveAttribute('style', oldTransform!)
    await page.getByRole('button', { name: '尝试手势观画', exact: true }).click()
    const image = page.locator('.pswp__item[aria-hidden="false"] .pswp__img:not(.pswp__img--placeholder)')
    await expect(image).toBeVisible()
    await expect(page.getByRole('dialog', { name: '作品观赏模式' })).toHaveCount(1)
    await expect(page.locator('.art-viewer [role="dialog"]')).toHaveCount(0)
    const before = await page.locator('.pswp__item[aria-hidden="false"] .pswp__zoom-wrap').getAttribute('style')
    await page.getByRole('button', { name: '缩放作品', exact: true }).click()
    await expect(page.locator('.pswp__item[aria-hidden="false"] .pswp__zoom-wrap')).not.toHaveAttribute('style', before!)
    await page.getByRole('button', { name: '下一幅', exact: true }).click()
    await expect(page.locator('.viewer-title')).toHaveText('Gesture fixture 179')
    await expect(image).toBeVisible()
    const stage = page.locator('.photoswipe-stage')
    const bounds = (await stage.boundingBox())!
    const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2
    const zoom = page.locator('.pswp__item[aria-hidden="false"] .pswp__zoom-wrap')
    const beforeWheel = await zoom.getAttribute('style')
    await page.mouse.move(cx, cy); await page.mouse.wheel(0, -400)
    await expect(zoom).not.toHaveAttribute('style', beforeWheel!)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
    const beforePinch = await zoom.getAttribute('style')
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 30, y: cy }, { x: cx + 30, y: cy }] })
    for (let spread = 40; spread <= 110; spread += 10) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - spread, y: cy }, { x: cx + spread, y: cy }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(zoom).not.toHaveAttribute('style', beforePinch!)
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await cdp.detach()
    await page.getByRole('button', { name: '下一幅', exact: true }).click()
    await expect(page.locator('.viewer-title')).toHaveText('Gesture fixture 178')
    await page.screenshot({ path: `.review-shots/github-photoswipe-${theme}.png` })
    await page.keyboard.press('Escape')
    await expect(page.locator('.pswp')).toHaveCount(0)
    await expect(opener).toBeFocused()
    expect(await page.evaluate(() => scrollY)).toBe(initialScroll)
    const samples: object[] = []
    for (let i = 0; i < 20; i++) {
      await opener.click()
      await expect(image).toBeVisible()
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Escape')
      await expect(page.locator('.pswp')).toHaveCount(0)
      samples.push(await page.evaluate(() => ({
        nodes: document.querySelectorAll('*').length,
        urls: (window as unknown as { galleryLiveUrls: Set<string> }).galleryLiveUrls.size,
      })))
    }
    await expect.poll(() => page.evaluate(() => (window as unknown as { galleryLiveUrls: Set<string> }).galleryLiveUrls.size)).toBeLessThanOrEqual(40)
    mkdirSync('runtime/github-reference', { recursive: true })
    writeFileSync(`runtime/github-reference/gallery-resource-${theme}.json`, JSON.stringify({ kind: 'synthetic-browser-trend', cycles: 20, samples }, null, 2))
    await testInfo.attach(`gallery-resource-trend-${theme}`, { body: JSON.stringify({ kind: 'synthetic-browser-trend', cycles: 20, samples }, null, 2), contentType: 'application/json' })
  })

  test(`dictionary and reproducible candidate preview ${theme}`, async ({ page }) => {
    await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
    await page.route('**/data/tags.json*', route => route.fulfill({ json: [
      { en: 'depth_of_field', cn: '景深', cat: 'Camera', aliases: ['dof'] },
      { en: 'park', cn: '公园', cat: 'Scene' },
    ] }))
    await page.goto('/prompt-builder?mode=pro')
    await page.getByRole('button', { name: '专家模式', exact: true }).click()
    await page.getByRole('tab', { name: '画面', exact: true }).click()
    await page.locator('.random-menu-trigger').click()
    await page.getByRole('textbox', { name: '灵感种子', exact: true }).fill('42')
    await page.getByRole('button', { name: '预览 3 组候选', exact: true }).click()
    await expect(page.locator('.random-candidate')).toHaveCount(3)
    const first = await page.locator('.random-candidate').allTextContents()
    await page.getByRole('button', { name: '预览 3 组候选', exact: true }).click()
    expect(await page.locator('.random-candidate').allTextContents()).toEqual(first)
    await page.getByRole('button', { name: '应用候选 1', exact: true }).click()
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: '保存种子与配置快照', exact: true }).click()
    expect((await download).suggestedFilename()).toBe('huiyu-inspiration-42.json')
    await page.screenshot({ path: `.review-shots/github-random-${theme}.png` })
    await page.keyboard.press('Escape')
    await expect(page.locator('.random-popover')).toHaveCount(0)
    await page.getByRole('tab', { name: '提示词', exact: true }).click()
    const input = page.locator('#stepTags input[type="text"]')
    await input.fill('景深, dof'); await input.press('Enter')
    await expect(page.locator('.manual-tag-en', { hasText: /^depth_of_field$/ })).toHaveCount(1)
    await page.getByRole('searchbox', { name: '搜索词条', exact: true }).fill('dof')
    await expect(page.locator('.tag-results button')).toHaveCount(1)
    await page.screenshot({ path: `.review-shots/github-tags-${theme}.png`, fullPage: true })
  })

  test(`history compatibility stays visible after initialization ${theme}`, async ({ page }) => {
    await page.addInitScript(theme => {
      localStorage.setItem('aics_theme', theme)
      localStorage.setItem('aics_pb_history', JSON.stringify([{ id: 321, engine: 'sd', character: 'nene', sceneTitle: '配方检查夹具', story: 'A quiet afternoon', manual_tags: ['depth_of_field'], seed: 0, cfg: 0, steps: 12, sampler: 'Euler a', size: '1024x1024' }]))
    }, theme)
    await page.goto('/gallery')
    await expect(page.locator('.artwork')).toHaveCount(1)
    await page.goto('/prompt-builder?regen=321')
    await expect(page.locator('.restore-notice')).toContainText('未记录底模')
    await expect(page.locator('.restore-notice')).toContainText('提示词按当前角色与编译规则重建')
    await page.screenshot({ path: `.review-shots/github-history-${theme}.png` })
    await page.getByRole('button', { name: '关闭配方检查', exact: true }).click()
    await expect(page.locator('.restore-notice')).toHaveCount(0)
  })
}
