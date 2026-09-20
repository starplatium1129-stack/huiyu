import { expect, test, type Locator } from '@playwright/test'
import { installShowcaseFixture } from './helpers/showcase'
import { textContrast } from './helpers/contrast'

async function contained(locator: Locator, width: number, height: number) {
  const box = (await locator.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(width)
  expect(box.y + box.height).toBeLessThanOrEqual(height)
}

for (const theme of ['light', 'dark']) {
  for (const width of [1440, 390]) {
    test(`searchable character filter ${theme} ${width}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height:844 })
      await page.emulateMedia({ reducedMotion:'reduce' })
      await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
      await installShowcaseFixture(page)
      await page.goto('/showcase')
      await expect(page.locator('.sample')).toHaveCount(2)
      const field = page.getByRole('combobox', { name:'筛选角色', exact:true })
      await expect(field).toHaveValue('全部角色')
      await field.fill('不存在的角色')
      await expect(page.getByText('没有匹配项，试试其他名字')).toBeVisible()
      await field.press('Escape')
      await expect(field).toHaveValue('全部角色')
      await expect(page.locator('.sample')).toHaveCount(2)
      await field.fill('雷电')
      const option = page.getByRole('option', { name:'雷电将军', exact:true })
      await expect(option).toBeVisible()
      await expect(page.locator('.studio-combobox-content').getByRole('option')).toHaveCount(1)
      await field.press('ArrowDown')
      await field.press('Enter')
      await expect(field).toHaveValue('雷电将军')
      await expect(field).toBeFocused()
      await expect(page.locator('.sample')).toHaveCount(1)
      await expect(page.locator('.sample-title')).toContainText('天守阁')
      await page.getByRole('button', { name:'展开筛选角色' }).click()
      const list = page.locator('.studio-combobox-content')
      await expect(list).toBeVisible()
      await contained(list, width, 844)
      expect(await option.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      if (width === 390) expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await page.screenshot({ path:info.outputPath(`combobox-${theme}-${width}.png`) })
      await field.press('Escape')
      await page.getByRole('button', { name:'清除筛选', exact:true }).click()
      await expect(field).toHaveValue('全部角色')
      await page.getByLabel('筛选作品类型').selectOption('popular')
      await field.fill('雷电')
      await option.click()
      await page.getByLabel('筛选作品类型').selectOption('scene')
      await expect(field).toHaveValue('全部角色')
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
