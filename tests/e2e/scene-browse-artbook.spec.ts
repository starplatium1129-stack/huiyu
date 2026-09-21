import { expect, test } from '@playwright/test'
import { textContrast } from './helpers/contrast'

for (const theme of ['dark', 'light']) for (const width of [1440, 768, 390]) {
  test(`browsing brings artwork forward ${theme} ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 })
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    for (const [name, route, art] of [
      ['scenes', '/scene-explorer', '.scene-grid .sc'],
      ['popular', '/popular-scenes', '.pop-thumb'],
      ['character', '/character', '.character-particle-stage'],
    ] as const) {
      await page.goto(route)
      await expect(page.locator(art).first()).toBeVisible()
      const box = (await page.locator(art).first().boundingBox())!
      if (width === 390) expect(box.y, name).toBeLessThan(name === 'scenes' ? 550 : name === 'popular' ? 640 : 420)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), name).toBeLessThanOrEqual(1)
      await page.screenshot({ path: info.outputPath(`${name}-${theme}-${width}.png`) })
      if (name !== 'scenes' && width <= 900) {
        const trigger = page.getByRole('button', { name: /^选择角色，当前/ })
        for (const label of await trigger.locator('strong, small, .pocket-action').all()) {
          expect(await label.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
        }
        await trigger.click()
        const dialog = page.getByRole('dialog', { name: '翻开角色画集' })
        await expect(dialog).toBeVisible()
        const search = dialog.getByRole('searchbox', { name: '搜索角色或作品' })
        await expect(search).toBeFocused()
        await search.fill(name === 'popular' ? '芙宁娜' : '四季夏目')
        await expect(dialog.locator('.directory-item')).toHaveCount(1)
        await page.screenshot({ path: info.outputPath(`${name}-directory-${theme}-${width}.png`) })
        await page.keyboard.press('Enter')
        await expect(dialog).toBeHidden()
        await expect(trigger).toBeFocused()
        await expect(trigger).toContainText(name === 'popular' ? '芙宁娜' : '四季夏目')
        await expect(page).toHaveURL(new RegExp(`character=${name === 'popular' ? 'furina' : 'natsume'}`))
        await trigger.click()
        await expect(search).toHaveValue(name === 'popular' ? '芙宁娜' : '四季夏目')
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
        await expect(trigger).toBeFocused()
      }
    }
    expect(errors).toEqual([])
  })
}

for (const theme of ['dark', 'light']) {
  test(`directory keeps filters when resized out of a modal ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/popular-scenes')
    await page.getByRole('button', { name: /^选择角色，当前/ }).click()
    const directory = page.getByRole('complementary', { name: '角色目录' })
    await directory.getByRole('button', { name: /^原神/ }).click()
    await directory.getByRole('searchbox').fill('芙宁娜')
    await page.setViewportSize({ width: 1440, height: 960 })
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(directory).toBeVisible()
    await expect(directory.getByRole('searchbox')).toHaveValue('芙宁娜')
    await expect(directory.locator('select option:checked')).toContainText('原神')
    expect(await page.evaluate(() => document.documentElement.style.overflow)).not.toBe('hidden')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: /^选择角色，当前/ }).click()
    await expect(directory.getByRole('searchbox')).toHaveValue('芙宁娜')
    await expect(directory.locator('.directory-item')).toHaveCount(1)
    await page.getByRole('button', { name: '关闭角色画集' }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test(`compact scene filters retain personal views and live search ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.goto('/scene-explorer')
    await expect(page.locator('.scene-grid .sc').first()).toBeVisible()
    await expect(page.locator('.scene-personal-nav')).toBeHidden()
    const filters = page.getByRole('button', { name: /^筛选与收藏/ })
    await filters.click()
    await expect(filters).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.scene-personal-nav')).toBeVisible()
    await page.locator('.scene-personal-nav').getByRole('button', { name: /^完整库/ }).click()
    await page.getByLabel('搜索场景', { exact: true }).fill('樱花')
    await expect(page.locator('.search-intent')).toBeVisible()
    await expect(page.locator('.scene-grid .sc').first()).toContainText('樱花')
    await filters.click()
    await expect(page.getByLabel('搜索场景', { exact: true })).toHaveValue('樱花')
    await page.getByRole('button', { name: '清空搜索' }).click()
    await expect(page.locator('.search-intent')).toHaveCount(0)
    await expect(page.getByLabel('搜索场景', { exact: true })).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  })
}
