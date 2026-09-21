import { test, expect } from '@playwright/test'

for (const theme of ['dark', 'light']) {
  for (const height of [640, 720, 900]) {
    test(`workspace generation stays in the first viewport ${theme} ${height}`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
      await page.goto('/prompt-builder')
      const generate = page.getByRole('button', { name: '生成图片', exact: true })
      await expect(generate).toBeVisible()
      const box = await generate.boundingBox()
      expect(box!.y).toBeGreaterThan(64)
      expect(box!.y + box!.height).toBeLessThanOrEqual(height)
      await page.goto('/prompt-builder?scene=sc006')
      await expect(page.locator('.atelier-context')).toContainText('平安夜')
      const sceneBox = await generate.boundingBox()
      expect(sceneBox!.y + sceneBox!.height).toBeLessThanOrEqual(height)
      await page.getByRole('button', { name: '专家模式', exact: true }).click()
      await expect(page.locator('.pb')).toHaveAttribute('data-director-mode', 'pro')
      const expertBox = await generate.boundingBox()
      expect(expertBox!.y + expertBox!.height).toBeLessThanOrEqual(height)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    })
  }

  test(`home puts saved work before inspiration without losing resume links ${theme}`, async ({ page }) => {
    await page.addInitScript(value => {
      localStorage.setItem('aics_theme', value)
      localStorage.setItem('aics_pb_history', JSON.stringify([
        { id: 'ux-saved', timestamp: 1700000000000, character: 'nene', sceneTitle: '已保存的雨夜' },
      ]))
    }, theme)
    await page.goto('/')
    const recent = page.locator('.recent-card')
    await expect(recent).toHaveCount(1)
    await expect(recent).toHaveAttribute('href', '/prompt-builder?regen=ux-saved')
    await expect(page.locator('#continueCta')).toHaveText('继续最近作品')
    const order = await page.locator('.home-page > section').evaluateAll(sections => sections.map(el => el.className))
    expect(order[0]).toContain('home-opening')
    expect(order[1]).toContain('home-resume')
    await expect(page.getByText('还没有最近作品', { exact: true })).toHaveCount(0)
  })
}

test('reduced motion removes list entry and filtered cards do not wait for animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/style')
  const card = page.locator('.style-mood-card').first()
  await expect(card).toBeVisible()
  await expect(card).toHaveCSS('animation-name', 'none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/scene-explorer')
  const scene = page.locator('.scene-grid > *').first()
  await expect(scene).toBeVisible()
  await expect(scene).toHaveCSS('animation-name', 'none')
})
