import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { textContrast } from './helpers/contrast'

// Browser-local fixture: no personal artwork or generation endpoint is used.
async function seedGallery(page: Page, theme: string, empty = false) {
  await page.route(/^http:\/\/[^/]+\/api\//, route => route.fulfill({ json: { ok: true, online: false } }))
  const images = ['natsume-home-cg.jpg', 'nene-home-cg.jpg', 'natsume-official.webp']
  await page.route('**/assets/gallery-fixture-*', route => {
    const item = Number(route.request().url().split('-').at(-1))
    if (item === 3) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750"><rect width="1200" height="750" fill="#d5e1e2"/><circle cx="900" cy="220" r="80" fill="#f8e5bf"/><path d="M0 390Q300 270 600 410T1200 360V750H0Z" fill="#829ea4"/><path d="M0 580Q400 430 750 600T1200 500V750H0Z" fill="#4e737e"/></svg>' })
    const index = item % images.length
    return route.fulfill({ body: readFileSync(`assets/characters/${images[index]}`), contentType: index === 2 ? 'image/webp' : 'image/jpeg' })
  })
  await page.addInitScript(({ theme, empty }) => {
    localStorage.setItem('aics_theme', theme)
    localStorage.setItem('aics_guest_guide_dismissed', '1')
    localStorage.setItem('aics_pb_history', JSON.stringify(empty ? [] : Array.from({ length: 6 }, (_, index) => ({
      id: `gallery-review-${index}`, sceneTitle: ['午后，和你', '光的形状', '一封写给秋日的长信：保留完整标题以验证小屏幕上的省略与布局', '雨后的街角', '海与她', '某个下午'][index],
      character: index % 2 ? 'nene' : 'natsume', prompt: 'Neutral UI review fixture',
      image_url: `/assets/gallery-fixture-${index}`, favorite: index < 2,
      timestamp: Date.now() - index * 1000, width: 832, height: 1216,
    }))))
    localStorage.setItem('aics_pb_projects', JSON.stringify([{ id: 'review', title: '秋日手记', history_ids: ['gallery-review-0', 'gallery-review-1'] }]))
  }, { theme, empty })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/gallery')
  await expect(page.getByRole('heading', { name: '我的作品', exact: true })).toBeVisible()
}

for (const theme of ['light', 'dark']) {
  test(`gallery browsing, selection and restoration ${theme}`, async ({ page }, testInfo) => {
    await seedGallery(page, theme)
    const cards = page.locator('.gallery-wall .artwork')
    await expect(cards).toHaveCount(6)
    await expect(page.locator('.artwork-image.is-loaded').first()).toBeVisible()
    await expect(page.getByRole('link', { name: '新建创作', exact: true })).toHaveAttribute('href', '/prompt-builder')
    const media = await cards.first().locator('.artwork-media').boundingBox()
    const caption = await cards.first().locator('.artwork-caption').boundingBox()
    expect(caption!.y).toBeGreaterThanOrEqual(media!.y + media!.height - 1)
    for (const selector of ['.artwork-name', '.artwork-date', '.gallery-title', '.gallery-subtitle', '.gallery-count', '.gallery-filter.active']) {
      expect(await page.locator(selector).first().evaluate(textContrast), selector).toBeGreaterThanOrEqual(4.5)
    }
    await page.screenshot({ path: testInfo.outputPath(`gallery-${theme}.png`), fullPage: true })
    await page.getByRole('button', { name: /收藏 2/ }).click()
    await expect(cards).toHaveCount(2)
    await page.getByRole('button', { name: '全部作品', exact: true }).click()
    await page.getByRole('searchbox', { name: '搜索作品' }).fill('午后')
    await expect(cards).toHaveCount(1)
    await page.getByRole('searchbox', { name: '搜索作品' }).fill('不存在的作品')
    await expect(page.getByText('当前筛选下没有作品')).toBeVisible()
    await page.getByRole('button', { name: '重置筛选', exact: true }).click()
    await expect(cards).toHaveCount(6)
    await page.getByLabel('按项目筛选').selectOption('review')
    await expect(cards).toHaveCount(2)
    await page.getByLabel('按项目筛选').selectOption('')
    await cards.first().locator('.artwork-button').click()
    await expect(page.getByRole('dialog', { name: '作品观赏模式' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(cards.first().locator('.artwork-button')).toBeFocused()
    await page.getByRole('button', { name: '选择', exact: true }).click()
    await cards.nth(0).locator('.artwork-button').click()
    await cards.nth(1).locator('.artwork-button').click()
    await page.getByRole('button', { name: '对比挑选（2–4 张）' }).click()
    await expect(page.locator('.candidate-card')).toHaveCount(2)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '移入回收站（2）', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '移入回收站', exact: true }).click()
    await expect(cards).toHaveCount(4)
    await page.getByRole('group', { name: '管理作品' }).getByRole('button', { name: /回收站/ }).click()
    await expect(page.locator('.trash-card')).toHaveCount(2)
    await page.getByRole('button', { name: /恢复作品/ }).first().click()
    await expect(page.locator('.trash-card')).toHaveCount(1)
    await page.getByRole('button', { name: '全部作品', exact: true }).click()
    await expect(cards).toHaveCount(5)
  })

  test(`gallery responsive layout ${theme}`, async ({ page }, testInfo) => {
    await seedGallery(page, theme)
    for (const width of [1280, 820, 390]) {
      await page.setViewportSize({ width, height: 960 })
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const columns = page.locator('.gallery-columns').first()
      await expect.poll(async () => columns.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(await columns.locator('.gallery-col').count())
      await expect(page.getByRole('button', { name: '选择', exact: true })).toBeInViewport()
      await expect(page.getByRole('searchbox', { name: '搜索作品' })).toBeInViewport()
      await page.screenshot({ path: testInfo.outputPath(`gallery-${theme}-${width}.png`) })
    }
  })

  test(`gallery empty state ${theme}`, async ({ page }, testInfo) => {
    await seedGallery(page, theme, true)
    await expect(page.getByText('展墙还在等你的第一幅作品')).toBeVisible()
    await expect(page.getByRole('link', { name: '开始绘制', exact: true })).toHaveAttribute('href', '/prompt-builder')
    await page.screenshot({ path: testInfo.outputPath(`gallery-empty-${theme}.png`) })
  })
}
