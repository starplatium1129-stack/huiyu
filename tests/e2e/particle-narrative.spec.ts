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

test('workspace state bars retain real character and service context', async ({ page }) => {
  await page.goto('/chat')
  const bar = page.locator('.conversation-head')
  await expect(bar).toContainText('绫地宁宁')
  await page.getByRole('tab', { name: /夏目/ }).click()
  await expect(bar).toContainText('四季夏目')
  await page.goto('/control')
  await expect(page.locator('.control-intro').getByRole('status')).toContainText(/服务在线|检测/)
})

test('director without a scene keeps mode controls without a redundant archive bar', async ({ page }) => {
  await page.goto('/prompt-builder')
  const basicMode = page.getByRole('button', { name: '场景模式', exact: true })
  await basicMode.click()
  await expect(basicMode).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('heading', { name: '开始绘制', exact: true })).toBeVisible()
  await expect(page.locator('.workspace-archive-bar')).toHaveCount(0)
})

test('director scene context keeps one state bar and survives an expert-mode round trip', async ({ page }) => {
  // Switching mode does not select a scene. Use the same scene fixture as the
  // existing director layout regressions instead of assuming an implicit scene.
  await page.goto('/prompt-builder?scene=sc006')
  const basicMode = page.getByRole('button', { name: '场景模式', exact: true })
  const expertMode = page.getByRole('button', { name: '专家模式', exact: true })
  const bar = page.getByRole('region', { name: '绘遇工作台状态', exact: true })
  await basicMode.click()
  await expect(basicMode).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.workspace-archive-bar')).toHaveCount(1)
  await expect(bar).toBeVisible()
  await expect(bar.getByRole('status')).toHaveCount(1)
  await expect(bar.getByRole('status')).toHaveText('场景模式')
  const sceneTitle = await bar.locator('.workspace-copy > span').innerText()
  expect(sceneTitle.trim()).not.toBe('')

  await expertMode.click()
  await expect(expertMode).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.workspace-archive-bar')).toHaveCount(0)
  await basicMode.click()
  await expect(page.locator('.workspace-archive-bar')).toHaveCount(1)
  await expect(bar.getByRole('status')).toBeVisible()
  await expect(bar.locator('.workspace-copy > span')).toHaveText(sceneTitle)
})

for (const path of ['/lora', '/scene-manager', '/control']) {
  test(`workspace ${path} keeps one concise state bar`, async ({ page }) => {
    await page.goto(path)
    if (path === '/control') {
      await expect(page.locator('.control-intro').getByRole('status')).toHaveCount(1)
      await expect(page.locator('.control-intro').getByRole('status')).toBeVisible()
    } else {
      const bar = page.locator('.workspace-archive-bar')
      await expect(bar).toHaveCount(1)
      await expect(bar.getByRole('status')).toHaveCount(1)
      await expect(bar.getByRole('status')).toBeVisible()
    }
  })
}

test('reduced motion leaves a static ambient background on phones', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  expect(await page.locator('.route-atmosphere').evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0)
  await expect(page.locator('.route-progress,.route-index')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391)
})
