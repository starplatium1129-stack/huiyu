import { expect, test } from '@playwright/test'
import { pickStudioOptionByValue, readStudioOptions } from './helpers/studioSelect'

test('different source spellings form one complete work group', async ({ page }) => {
  await page.goto('/character')
  const series = page.getByLabel('筛选角色系列')
  const oregairu = (await readStudioOptions(series)).find(option => option.value === 'Oregairu')
  expect(oregairu?.label).toContain('4')
  await pickStudioOptionByValue(series, 'Oregairu')
  await expect(page.locator('.directory-item')).toHaveCount(4)
  await pickStudioOptionByValue(series, 'Saenai Heroine no Sodatekata')
  await expect(page.locator('.directory-item')).toHaveCount(2)

})

test('replacement portrait and compact avatar load with an honest source label', async ({ page }) => {
  await page.goto('/character?character=katou_megumi')
  await expect(page.locator('.character-name')).toHaveText('加藤惠')
  await expect(page.locator('.portrait-badge')).toContainText('角色场景样张')
  const portrait = page.locator('.portrait-image')
  await expect.poll(() => portrait.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  const card = page.locator('.directory-item[data-character="katou_megumi"]')
  await expect(card.locator('img')).toHaveAttribute('src', '/assets/characters/thumbs/popular-katou_megumi.webp')
})
