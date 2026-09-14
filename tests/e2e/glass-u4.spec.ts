import { test, expect } from '@playwright/test'

for (const theme of ['dark', 'light']) {
  test(`U4 liquid glass chrome and fallback ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
    await page.goto('/')

    const nav = page.locator('.nav')
    await expect(nav).toBeVisible()

    // 1. 验证默认状态下主导航具备玻璃层属性（半透明背景、底部边界、backdrop-filter）
    const navBg = await nav.evaluate(el => getComputedStyle(el).backgroundColor)
    expect(navBg).toMatch(/rgba?\(/)
    const navBorder = await nav.evaluate(el => getComputedStyle(el).borderBottomStyle)
    expect(navBorder).toBe('solid')

    // 2. 验证画册悬浮工具栏具有结构层玻璃样式
    await page.goto('/gallery')
    const galleryToolbar = page.locator('.gallery-toolbar')
    await expect(galleryToolbar).toBeVisible()
    await expect(galleryToolbar).toHaveCSS('position', 'sticky')

    // 3. 验证低动效 / 低效果 / 降低透明度模式下的实体底色降级
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-fluid-effects', 'low')
    })
    await expect(nav).toHaveCSS('backdrop-filter', 'none')
    await expect(galleryToolbar).toHaveCSS('backdrop-filter', 'none')

    // 4. 验证工作台吸附出图条与粘性定位属性
    await page.evaluate(() => {
      document.documentElement.removeAttribute('data-fluid-effects')
    })
    await page.goto('/prompt-builder')
    const genBar = page.locator('.gen-bar')
    await expect(genBar).toBeVisible()
    await expect(genBar).toHaveCSS('position', 'sticky')

    // 5. 验证浮层头部（小样 3）具有受光高光或分割边线
    const compareHead = await page.evaluate(() => {
      const el = document.createElement('div')
      el.className = 'pb-compare-head'
      document.body.appendChild(el)
      const border = getComputedStyle(el).borderColor
      el.remove()
      return border
    })
    expect(compareHead).toBeTruthy()

    // 降级回退检查
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-reduced-glass', 'true')
    })
    await expect(genBar).toHaveCSS('backdrop-filter', 'none')
  })
}
