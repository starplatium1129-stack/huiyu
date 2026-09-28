import { expect, test } from '@playwright/test'

test('ambient background persists across navigation without foreground effects', async ({ page }) => {
  await page.goto('/prompt-builder')
  const backdrop = await page.locator('.route-atmosphere').elementHandle()
  await expect(page.locator('.route-atmosphere')).toHaveCount(1)
  await page.getByRole('navigation').getByRole('link', { name: '参考画册', exact: true }).click()
  await expect(page).toHaveURL(/showcase$/)
  expect(await backdrop!.evaluate(el => el.isConnected)).toBe(true)
  await expect(page.locator('.route-atmosphere canvas,.route-cut,.sakura-fall')).toHaveCount(0)
})

test('selected scene survives an expert-mode round trip', async ({ page }) => {
  await page.goto('/prompt-builder?scene=sc006')
  const studio = page.locator('article.pb')
  const context = page.locator('.atelier-context')
  const basicMode = page.getByRole('button', { name: '场景模式', exact: true })
  const expertMode = page.getByRole('button', { name: '专家模式', exact: true })
  await basicMode.click()
  await expect(studio).toHaveAttribute('data-director-mode', 'basic')
  await expect(studio).toHaveAttribute('data-character', 'nene')
  await expect(context).toContainText('平安夜的手作礼物')
  const sceneContext = await context.innerText()

  await expertMode.click()
  await expect(studio).toHaveAttribute('data-director-mode', 'pro')
  await expect(studio).toHaveAttribute('data-character', 'nene')
  await expect(context).toHaveText(sceneContext)
  await basicMode.click()
  await expect(studio).toHaveAttribute('data-director-mode', 'basic')
  await expect(studio).toHaveAttribute('data-character', 'nene')
  await expect(context).toHaveText(sceneContext)
})



test('reduced motion leaves a static ambient background in desktop windows', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  expect(await page.locator('.route-atmosphere').evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0)
  await expect(page.locator('.route-progress,.route-index')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1441)
})
