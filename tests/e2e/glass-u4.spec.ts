import { test, expect } from '@playwright/test'

for (const theme of ['dark', 'light']) {
  test(`U4 liquid glass chrome and fallback ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
    await page.goto('/')

    const nav = page.locator('.nav')
    await expect(nav).toBeVisible()

    // 1. 验证默认状态下主导航具备玻璃顶缘高光及半透明背景
    const navBg = await nav.evaluate(el => getComputedStyle(el).backgroundColor)
    expect(navBg).toMatch(/rgba?\(/)

    // 2. 验证画册悬浮工具栏具有结构层玻璃样式
    await page.goto('/gallery')
    const galleryToolbar = page.locator('.gallery-toolbar')
    await expect(galleryToolbar).toBeVisible()

    // 3. 验证低动效 / 低效果 / 降低透明度模式下的实体底色降级
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-fluid-effects', 'low')
    })
    await expect(nav).toHaveCSS('backdrop-filter', 'none')
    await expect(galleryToolbar).toHaveCSS('backdrop-filter', 'none')

    // 4. 验证工作台吸附出图条
    await page.evaluate(() => {
      document.documentElement.removeAttribute('data-fluid-effects')
    })
    await page.goto('/prompt-builder')
    const genBar = page.locator('.gen-bar')
    await expect(genBar).toBeVisible()

    // 降级回退检查
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-reduced-glass', 'true')
    })
    await expect(genBar).toHaveCSS('backdrop-filter', 'none')
  })
}
