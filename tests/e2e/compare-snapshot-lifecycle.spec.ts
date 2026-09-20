import { expect, test } from '@playwright/test'

declare global {
  interface Window { snapshotRevocations?: string[] }
}

test('comparison images decode after engine URL rotation and obsolete snapshots are released', async ({ page }) => {
  let generation = 0
  await page.route(/^http:\/\/[^/]+\/api\//, route => route.fulfill({ json: { ok: true, online: false, models: [] } }))
  await page.route('**/api/generation/status', route => route.fulfill({ json: {
    ok: true, online: true, provider: 'webui', webuiOnline: true, comfyFallbackOnline: false,
    checkpoint: 'fixture', models: [], loras: [], samplers: ['Euler a'], schedulers: ['Normal'], pending: 0, maxPending: 4,
    capabilities: { basic: true, hires: false, faceDetailer: false, hiresUpscalers: [] },
  } }))
  await page.route('**/api/generation/jobs', route => {
    generation++
    return route.fulfill({ json: { ok: true, job: {
      id: `comparison-${generation}`, provider: 'webui', status: 'succeeded', seed: generation * 100,
      resultAvailable: true, resultUrl: `/compare-fixture/${generation}.jpg`, metadata: { seed: generation * 100 },
    } } })
  })
  await page.route('**/compare-fixture/*.jpg', route => route.fulfill({ path: 'assets/characters/natsume-home-cg.jpg', contentType: 'image/jpeg' }))
  await page.addInitScript(() => {
    localStorage.setItem('aics_theme', 'light')
    localStorage.setItem('aics_pb_director_mode', 'pro')
    localStorage.setItem('aics_draw_engine', 'sd')
    const revoke = URL.revokeObjectURL.bind(URL)
    const revoked: string[] = []
    Object.assign(window, { snapshotRevocations: revoked })
    URL.revokeObjectURL = url => { revoked.push(url); revoke(url) }
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/prompt-builder?scene=sc001')
  await page.getByRole('button', { name: '专家模式', exact: true }).click()
  await page.locator('.engine-switch button').first().click()
  for (let i = 1; i <= 2; i++) {
    await page.getByTestId('sd-generate').click()
    await expect(page.locator('.result-image')).toBeVisible()
    await expect(page.getByTestId('sd-generate')).toBeEnabled()
  }
  const open = page.getByRole('button', { name: '与上一张对比', exact: true })
  await expect(open).toBeEnabled()
  await open.click()
  const dialog = page.getByRole('dialog', { name: '出图对比' })
  await expect(dialog).toContainText('Seed 100')
  await expect(dialog).toContainText('Seed 200')
  const urls = await dialog.locator('img').evaluateAll(images => images.map(img => (img as HTMLImageElement).src))
  for (const img of await dialog.locator('img').all()) {
    await expect(img).toHaveJSProperty('complete', true)
    await expect(img).not.toHaveJSProperty('naturalWidth', 0)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.getByTestId('sd-generate').click()
  await expect(page.getByTestId('sd-generate')).toBeEnabled()
  await open.click()
  await expect(dialog).toContainText('Seed 200')
  await expect(dialog).toContainText('Seed 300')
  await expect(dialog.locator('img').first()).toHaveAttribute('src', urls[1])
  for (const img of await dialog.locator('img').all()) {
    await expect(img).toHaveJSProperty('complete', true)
    await expect(img).not.toHaveJSProperty('naturalWidth', 0)
  }
  const revoked = await page.evaluate(() => window.snapshotRevocations!)
  expect(revoked.filter(url => url === urls[0])).toHaveLength(1)
  expect(revoked).not.toContain(urls[1])
})
