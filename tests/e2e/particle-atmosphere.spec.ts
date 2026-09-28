import { expect, test } from '@playwright/test'

// Discovery uses character artwork; particle contracts remain on the other narrative surfaces.
test.beforeEach(async ({ page }) => {
  await page.goto('/scene-explorer')
  const guide = page.getByRole('dialog', { name: '访客导览' })
  if (await guide.isVisible()) await guide.getByRole('button', { name: '开始创作', exact: true }).click()
})

test('selected discovery artwork keeps search reachable with reduced motion', async ({ page }) => {
  const atlas = page.locator('.scene-atlas')
  await atlas.getByRole('button', { name: '四季夏目', exact: true }).click()
  await page.locator('.scene-cats').getByRole('button', { name: /恋爱/ }).click()
  await expect(atlas.locator('.eyebrow')).toContainText('恋爱')
  await expect(atlas.locator('img.current')).toHaveAttribute('alt', '四季夏目')
  await expect(atlas.locator('canvas')).toHaveCount(0)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => scrollTo(0, 0))
  const portrait = page.locator('.scene-atlas-portrait img.current')
  expect(await portrait.evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s')
  await expect(page.locator('#sceneSearch')).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1441)
})
