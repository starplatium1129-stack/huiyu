import { expect, test } from '@playwright/test'

const archivePages = [
  { path: '/character', heading: '角色档案' },
  { path: '/style', heading: '画风' },
  { path: '/showcase', heading: '把心动，一页页收藏。' },
  { path: '/gallery', heading: '我的作品' },
  { path: '/color-script', heading: '色彩情绪' },
  { path: '/scenario', heading: '剧本模式' },
] as const

test('browsing pages expose one concise heading without decorative particles', async ({ page }) => {
  for (const entry of archivePages) {
    await page.goto(entry.path)
    await expect(page.getByRole('heading', { level: 1, name: entry.heading, exact: true })).toBeVisible()
    await expect(page.locator('main h1')).toHaveCount(1)
    await expect(page.locator('.archive-particles')).toHaveCount(0)
  }
})

test('archive content reveals and route changes leave one active page', async ({ page }) => {
  await page.goto('/style')
  await expect(page.locator('.mood-grid[data-reveal]')).toHaveClass(/revealed/)
  await page.locator('.nav-more-trigger').click()
  await page.getByRole('dialog', { name: '更多页面' }).getByRole('link', { name: '我的作品', exact: true }).click()
  await expect(page).toHaveURL(/\/gallery$/)
  await expect(page.locator('main h1')).toHaveCount(1)
  await expect(page.getByRole('heading', { level: 1, name: '我的作品', exact: true })).toBeVisible()
  await expect(page.locator('.gallery-toolbar[data-reveal]')).toHaveClass(/revealed/)
})

test('archive pages remain static and overflow-free on reduced-motion phones', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 390, height: 844 })
  for (const path of ['/style', '/gallery', '/showcase']) {
    await page.goto(path)
    await expect(page.locator('main h1')).toBeVisible()
    await expect(page.locator('.archive-particles')).toHaveCount(0)
    const widths = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
    expect(Math.max(widths.document, widths.body)).toBeLessThanOrEqual(widths.viewport + 1)
  }
})

test('character directory filters by franchise and opens matching details', async ({ page }) => {
  await page.goto('/character')
  const directory = page.getByRole('complementary', { name: '角色目录' })
  await expect(directory.locator('.directory-item').first()).toBeVisible()
  const total = await directory.locator('.directory-item').count()
  expect(total).toBeGreaterThanOrEqual(45)
  const search = directory.getByRole('searchbox', { name: '搜索角色或作品' })
  await search.fill('凯尔希')
  await directory.locator('.directory-item').first().click()
  await expect(page.locator('.character-name')).toHaveText('凯尔希')
  await expect(page.locator('.character-hero')).toBeVisible()
  await search.fill('')
  await directory.getByLabel('筛选角色系列').selectOption({ label: await directory.locator('option').filter({ hasText: /^明日方舟 ·/ }).innerText() })
  const arknights = await directory.locator('.directory-item').count()
  expect(arknights).toBeGreaterThanOrEqual(13)
  expect(arknights).toBeLessThan(total)
  await directory.getByLabel('筛选角色系列').selectOption('')
  await search.fill('Fate')
  await expect.poll(() => directory.locator('.directory-item').count()).toBeGreaterThanOrEqual(3)
  expect(await directory.locator('.directory-item').count()).toBeLessThan(total)
  await directory.getByRole('button', { name: '清除筛选' }).click()
  await expect(directory.locator('.directory-item')).toHaveCount(total)
})
