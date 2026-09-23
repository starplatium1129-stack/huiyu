import { expect, test } from '@playwright/test'
import { pickStudioOptionByValue, readStudioOptions } from './helpers/studioSelect'

test('all franchise groups have Chinese labels while both language aliases remain searchable', async ({ page }) => {
  await page.goto('/popular-scenes')
  const series = page.getByLabel('筛选角色系列')
  const options = await readStudioOptions(series)
  const blueArchive = options.find(option => option.value === 'Blue Archive')
  expect(blueArchive).toBeDefined()
  expect(options.filter(option => !/[一-鿿]/.test(option.label))).toEqual([])
  const count = Number(blueArchive!.label.split(' · ').at(-1))
  await pickStudioOptionByValue(series, 'Blue Archive')
  await expect(page.locator('.directory-item')).toHaveCount(count)
  const search = page.getByRole('searchbox', { name: '搜索角色或作品' })
  await search.fill('Blue Archive')
  await expect(page.locator('.directory-item')).toHaveCount(count)
  await search.fill('蔚蓝档案')
  await expect(page.locator('.directory-item')).toHaveCount(count)
})

test('home character captions use the shared Chinese franchise labels', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.pop-cap-franchise').first()).toBeVisible()
  const labels = await page.locator('.pop-cap-franchise').allTextContents()
  expect(labels.length).toBeGreaterThan(0)
  expect(labels.filter(label => !/[\u4e00-\u9fff]/.test(label))).toEqual([])
})
