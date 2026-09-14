import { test, expect } from '@playwright/test'

for (const theme of ['dark', 'light']) for (const width of [1440, 390]) {
  test(`U2 mode controls retain drafts ${theme} ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 960 })
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme as 'dark' | 'light' })
    await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
    await page.goto('/prompt-builder')
    await expect(page.locator('.gen-bar')).toBeVisible()
    if (width === 390) {
      expect((await page.locator('.gen-bar-size select').boundingBox())!.width).toBeGreaterThanOrEqual(140)
    }
    await expect(page.locator('.utility-trigger')).toHaveAccessibleName(/尚未备份/)
    await page.locator('[aria-controls="material-scenes"]').click()
    await page.locator('.scene-search').fill('樱花')
    await page.locator('[aria-controls="material-story"]').click()
    const story = page.locator('.story-input')
    await story.fill('审核用草稿：窗外下着雨。')
    await page.getByRole('button', { name: '专家模式', exact: true }).click()
    await expect(story).toHaveValue('审核用草稿：窗外下着雨。')
    await page.locator('.engine-btn').filter({ hasText: 'SD 引擎' }).click()
    await page.getByLabel('CFG', { exact: true }).fill('6.5')
    await page.getByLabel('CFG', { exact: true }).press('Tab')
    await page.getByRole('button', { name: '场景模式', exact: true }).click()
    await expect(story).toHaveValue('审核用草稿：窗外下着雨。')
    await page.locator('[aria-controls="material-scenes"]').click()
    await expect(page.locator('.scene-search')).toHaveValue('樱花')
    await page.getByRole('button', { name: '专家模式', exact: true }).click()
    // 场景模式沿用自动路线；返回 SD 后检查该引擎的草稿，而非假设路线不切换。
    await page.locator('.engine-btn').filter({ hasText: 'SD 引擎' }).click()
    await expect(page.getByLabel('CFG', { exact: true })).toHaveValue('6.5')

    await page.locator('[aria-controls="material-character"]').click()
    await page.getByRole('button', { name: /热门角色/ }).first().click()
    const subject = await page.locator('.pb').getAttribute('data-character')
    const outfit = await page.locator('.outfit-chip.active').textContent()
    const disabledEngine = page.locator('.engine-btn').first()
    await expect(disabledEngine).toBeDisabled()
    await expect(disabledEngine).toHaveCSS('opacity', '1')
    await expect(disabledEngine).toHaveCSS('color', await disabledEngine.evaluate(el => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--text-disabled)'; el.append(probe)
      const color = getComputedStyle(probe).color; probe.remove(); return color
    }))
    await page.getByRole('button', { name: '场景模式', exact: true }).click()
    await page.getByRole('button', { name: '专家模式', exact: true }).click()
    await expect(page.locator('.pb')).toHaveAttribute('data-character', subject!)
    await expect(page.locator('.outfit-chip.active')).toHaveText(outfit!)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: info.outputPath(`${theme}-${width}-u2.png`), fullPage: true })
  })
}
