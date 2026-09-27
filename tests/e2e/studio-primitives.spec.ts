import { expect, test, type Locator } from '@playwright/test'
import { installShowcaseFixture } from './helpers/showcase'
import { textContrast } from './helpers/contrast'
import { pickStudioOptionByValue } from './helpers/studioSelect'

for (const theme of ['dark', 'light']) {
  test(`chat menu lazily opens styled panels ${theme}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion:'reduce' })
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.route(/^http:\/\/[^/]+\/api\//, route => route.fulfill({ json:{ ok:true, online:false, models:[], loras:[], styleLoras:[] } }))
    await page.goto('/chat')
    await expect(page.locator('h1')).toBeVisible()
    for (const [label, selector, closeLabel] of [
      ['对话归档', '.chat-archive-panel', '收起'],
      ['长期记忆', '.chat-memory-panel', '关闭长期记忆'],
      ['我的档案', '.chat-user-profile', '关闭用户档案'],
    ]) {
      await page.locator('.chat-more-trigger').click()
      await page.getByRole('menuitem', { name:label, exact:true }).click()
      const panel = page.locator(selector).filter({ visible:true })
      await expect(panel).toHaveCount(1)
      await expect(panel).toHaveCSS('border-top-style', 'solid')
      expect(await panel.locator('strong').first().evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      await panel.getByRole('button', { name:closeLabel, exact:true }).click()
      await expect(panel).toHaveCount(0)
    }
  })
}

async function contained(locator: Locator, width: number, height: number) {
  const box = (await locator.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(width)
  expect(box.y + box.height).toBeLessThanOrEqual(height)
}

for (const theme of ['light', 'dark']) {
  for (const width of [1440, 390]) {
    test(`character select keyboard filter ${theme} ${width}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height:844 })
      await page.emulateMedia({ reducedMotion:'reduce' })
      await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
      await installShowcaseFixture(page)
      await page.goto('/showcase')
      await expect(page.locator('.sample')).toHaveCount(2)
      await page.locator('.showcase-filters > summary').press('Enter')
      const field = page.getByRole('combobox', { name:'筛选角色', exact:true })
      await expect(field).toHaveAttribute('data-value', 'all')
      await expect(field).toHaveText('全部角色')
      const list = page.locator('.studio-select-content')
      const option = page.getByRole('option', { name:'雷电将军', exact:true })
      // Highlighting a different choice must not commit it when Escape closes the portal.
      await field.press('ArrowDown')
      await expect(list).toBeVisible()
      await page.keyboard.press('End')
      await expect(option).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(list).toBeHidden()
      await expect(field).toBeFocused()
      await expect(field).toHaveAttribute('data-value', 'all')
      await expect(page.locator('.sample')).toHaveCount(2)
      await field.press('ArrowDown')
      await page.keyboard.press('End')
      await expect(option).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(field).toHaveAttribute('data-value', 'raiden_shogun')
      await expect(field).toHaveText('雷电将军')
      await expect(field).toBeFocused()
      await expect(page.locator('.sample')).toHaveCount(1)
      await expect(page.locator('.sample-title')).toContainText('天守阁')
      await field.press('Enter')
      await expect(list).toBeVisible()
      await expect(option).toHaveAttribute('data-state', 'checked')
      await expect(page.locator('.showcase-filters .studio-select-content')).toHaveCount(0)
      await contained(list, width, 844)
      expect(await option.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      if (width === 390) expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await page.screenshot({ path:info.outputPath(`select-${theme}-${width}.png`) })
      await page.keyboard.press('Escape')
      await expect(list).toBeHidden()
      await expect(field).toBeFocused()
      await page.getByRole('button', { name:'清除筛选', exact:true }).click()
      await expect(field).toHaveAttribute('data-value', 'all')
      await expect(field).toHaveText('全部角色')
      await pickStudioOptionByValue(page.getByLabel('筛选作品类型'), 'popular')
      await field.press('ArrowDown')
      await page.keyboard.press('End')
      await expect(option).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(field).toHaveAttribute('data-value', 'raiden_shogun')
      await pickStudioOptionByValue(page.getByLabel('筛选作品类型'), 'scene')
      await expect(field).toHaveAttribute('data-value', 'all')
      await expect(field).toHaveText('全部角色')
      await expect(page.locator('.sample-title')).toContainText('测试场景')
    })
  }

  test(`palette popover focus and collision ${theme}`, async ({ page }, info) => {
    await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
    await page.emulateMedia({ reducedMotion:'reduce' })
    // No generation or backend mutation is available to this UI-only fixture.
    await page.route(/^http:\/\/[^/]+\/api\//, route => route.fulfill({ json:{ ok:true, online:false, models:[], loras:[], styleLoras:[] } }))
    await page.route('**/data/tags.json*', route => route.fulfill({ json:[{ en:'park', cn:'公园', cat:'Scene' }] }))
    await page.goto('/prompt-builder?mode=pro')
    await page.getByRole('button', { name:'专家模式', exact:true }).click()
    const trigger = page.getByRole('button', { name:'夏目的调色笔记', exact:true })
    const popover = page.getByRole('dialog', { name:'夏目的调色笔记', exact:true })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height:720 })
      await trigger.click()
      await expect(popover).toBeVisible()
      await page.getByRole('textbox', { name:'灵感种子', exact:true }).fill('42')
      await page.getByRole('button', { name:'预览 3 组候选', exact:true }).click()
      await expect(page.locator('.random-candidate')).toHaveCount(3)
      await contained(popover, width, 720)
      expect(await page.locator('.random-label').evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      await page.screenshot({ path:info.outputPath(`popover-${theme}-${width}.png`) })
      await page.keyboard.press('Escape')
      await expect(popover).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await trigger.press('Enter')
      await expect(popover).toBeVisible()
      await page.getByRole('button', { name:'关闭调色笔记', exact:true }).click()
      await expect(trigger).toBeFocused()
    }
  })
}
