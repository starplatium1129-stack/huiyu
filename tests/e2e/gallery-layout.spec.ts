import { expect, test, type Page } from '@playwright/test'
import { textContrast } from './helpers/contrast'
import { pickStudioOptionByValue } from './helpers/studioSelect'

// Browser-local fixture: no personal artwork or generation endpoint is used.
async function seedGallery(page: Page, theme: string, empty = false, reducedMotion: 'reduce' | 'no-preference' = 'reduce') {
  await page.route(/^http:\/\/[^/]+\/api\//, route => route.fulfill({ json: { ok: true, online: false } }))
  await page.route('**/assets/gallery-fixture-*', route => {
    const item = Number(route.request().url().split('-').at(-1))
    if (item === 3) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750"><rect width="1200" height="750" fill="#d5e1e2"/><circle cx="900" cy="220" r="80" fill="#f8e5bf"/><path d="M0 390Q300 270 600 410T1200 360V750H0Z" fill="#829ea4"/><path d="M0 580Q400 430 750 600T1200 500V750H0Z" fill="#4e737e"/></svg>' })
    const [width, height] = [[832, 1216], [1216, 832], [1024, 1024]][item % 3]
    return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#746687"/><circle cx="250" cy="250" r="140" fill="#d5e1e2"/><path d="M0 600L500 350L1200 800V1400H0Z" fill="#4e737e"/></svg>` })
  })
  await page.addInitScript(({ theme, empty }) => {
    localStorage.setItem('aics_theme', theme)
    localStorage.setItem('aics_guest_guide_dismissed', '1')
    localStorage.setItem('aics_pb_history', JSON.stringify(empty ? [] : Array.from({ length: 6 }, (_, index) => ({
      id: `gallery-review-${index}`, sceneTitle: ['午后，和你', '光的形状', '一封写给秋日的长信：保留完整标题以验证小屏幕上的省略与布局', '雨后的街角', '海与她', '某个下午'][index],
      character: index % 2 ? 'nene' : 'natsume', prompt: 'Neutral UI review fixture',
      image_url: `/assets/gallery-fixture-${index}`, favorite: index < 2,
      parent_id: index === 0 ? 'gallery-review-1' : undefined,
      manual_tags: index < 2 ? ['春日'] : ['夜景'],
      timestamp: Date.now() - index * 1000, width: 832, height: 1216,
    }))))
    localStorage.setItem('aics_pb_projects', JSON.stringify([{ id: 'review', title: '秋日手记', history_ids: ['gallery-review-0', 'gallery-review-1'] }]))
  }, { theme, empty })
  await page.emulateMedia({ reducedMotion })
  await page.goto('/gallery')
  await expect(page.getByRole('heading', { name: '我的作品', exact: true })).toBeVisible()
}

for (const theme of ['light', 'dark']) {
  test(`gallery preview keeps real images through the closing fade ${theme}`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await seedGallery(page, theme, false, 'no-preference')
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    const opener = page.locator('.artwork-button').first()
    const viewer = page.locator('.art-viewer')
    await expect(opener.locator('.artwork-image-hd.is-loaded')).toBeVisible()
    const modes = [
      { name: 'original', image: '.zoomable-img' },
      { name: 'comparison', image: '.image-compare-slider .after-img' },
      { name: 'gesture', image: '.pswp__item[aria-hidden="false"] .pswp__img:not(.pswp__img--placeholder)' },
    ]
    for (const mode of modes) {
      if (mode.name === 'original') {
        await opener.scrollIntoViewIfNeeded()
        const opening = await opener.evaluate(async (button: HTMLButtonElement) => {
          const frames: { left: number; top: number; width: number }[] = []
          const source = button.querySelector('.artwork-image-hd')!.getBoundingClientRect()
          button.focus({ preventScroll: true }); button.click()
          const start = performance.now()
          while (performance.now() - start < 1500) {
            await new Promise(requestAnimationFrame)
            const proxy = document.querySelector('[data-image-origin-proxy]')
            if (proxy) {
              const rect = proxy.getBoundingClientRect()
              frames.push({ left: rect.left, top: rect.top, width: rect.width })
            } else if (frames.length) {
              const target = document.querySelector('.art-viewer .zoomable-img')!.getBoundingClientRect()
              return { frames, sourceWidth: source.width, targetWidth: target.width, targetLeft: target.left, targetTop: target.top }
            }
          }
          throw new Error('Gallery did not animate an image from its source card')
        })
        expect(opening.frames.length).toBeGreaterThan(2)
        expect(opening.frames[0].width).toBeGreaterThanOrEqual(opening.sourceWidth - 1)
        expect(opening.frames[0].width).toBeLessThan(opening.targetWidth - 2)
        const last = opening.frames.at(-1)!
        expect(Math.abs(last.width - opening.targetWidth)).toBeLessThan(4)
        expect(Math.abs(last.left - opening.targetLeft)).toBeLessThan(4)
        expect(Math.abs(last.top - opening.targetTop)).toBeLessThan(4)
        await testInfo.attach(`gallery-origin-${theme}`, { body: JSON.stringify(opening), contentType: 'application/json' })
      } else await opener.click()
      await expect(viewer).toHaveCSS('transform', 'none')
      if (mode.name === 'comparison') await viewer.locator('.viewer-compare-toggle').click()
      if (mode.name === 'gesture') {
        await viewer.locator('.viewer-more summary').click()
        await viewer.getByRole('button', { name: '尝试手势观画', exact: true }).click()
      }
      await expect.poll(() => viewer.locator(mode.image).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
      await viewer.screenshot({ path: testInfo.outputPath(`gallery-preview-${theme}-${mode.name}.png`) })
      const frames = await viewer.evaluate(async (element, selector) => {
        const image = element.querySelector<HTMLImageElement>(selector)!
        const samples: { opacity: number; imageRetained: boolean; proxyWidth: number | null }[] = []
        const start = performance.now()
        ;(element.querySelector('.viewer-close') as HTMLButtonElement).click()
        while (performance.now() - start < 3000) {
          await new Promise(requestAnimationFrame)
          const style = getComputedStyle(element)
          if (style.display === 'none') return samples
          samples.push({ opacity: Number(style.opacity), imageRetained: image.isConnected && image.complete && image.naturalWidth > 0 && element.querySelector(selector) === image,
            proxyWidth: element.querySelector('[data-image-origin-proxy]')?.getBoundingClientRect().width ?? null })
        }
        throw new Error('Gallery closing transition did not complete')
      }, mode.image)
      expect(frames.some(frame => frame.opacity > .05 && frame.opacity < .9), mode.name).toBe(true)
      expect(frames.some(frame => frame.opacity > 0 && frame.opacity < .1), mode.name).toBe(true)
      expect(frames.every(frame => frame.imageRetained), mode.name).toBe(true)
      const proxyWidths = frames.flatMap(frame => frame.proxyWidth === null ? [] : [frame.proxyWidth])
      expect(proxyWidths.length, mode.name).toBeGreaterThan(2)
      expect(proxyWidths[0] - proxyWidths.at(-1)!, mode.name).toBeGreaterThan(20)
      await expect(viewer).toBeHidden()
      await expect(page.locator('[data-image-origin-proxy]')).toHaveCount(0)
      await expect(viewer.locator(mode.image)).toHaveCount(0)
      await expect(opener).toBeFocused()
      await testInfo.attach(`gallery-fade-${theme}-${mode.name}`, { body: JSON.stringify(frames), contentType: 'application/json' })
    }

    await opener.click()
    await expect(viewer).toHaveCSS('transform', 'none')
    const gestureImage = viewer.locator(modes[2].image)
    await expect(gestureImage).toBeVisible()
    const reversal = await viewer.evaluate(async (element, selector) => {
      const image = element.querySelector(selector)
      ;(element.querySelector('.viewer-close') as HTMLButtonElement).click()
      const start = performance.now()
      while (performance.now() - start < 3000) {
        await new Promise(requestAnimationFrame)
        const opacity = Number(getComputedStyle(element).opacity)
        if (opacity > .2 && opacity < .8) {
          const retained = image?.isConnected === true
          ;(document.querySelector('.artwork-button') as HTMLButtonElement).click()
          await new Promise(requestAnimationFrame)
          return { retained, reused: image === element.querySelector(selector) }
        }
      }
      throw new Error('Gallery close did not expose a reversible fade')
    }, modes[2].image)
    expect(reversal).toEqual({ retained: true, reused: true })
    await expect(viewer).toHaveClass(/open/)
    await expect(viewer).toHaveCSS('transform', 'none')
    await expect(gestureImage).toBeVisible()
    await viewer.getByRole('link', { name: '沿用配方', exact: true }).click()
    await expect(page).toHaveURL(/\/prompt-builder\?remix=/)
    await expect(page.locator('.photoswipe-stage')).toHaveCount(0)
    await expect(viewer).toBeHidden()
    expect(errors).toEqual([])
  })

  test(`gallery browsing, selection and restoration ${theme}`, async ({ page }, testInfo) => {
    await seedGallery(page, theme)
    const cards = page.locator('.gallery-wall .artwork')
    await expect(cards).toHaveCount(6)
    await expect(page.locator('.gallery-album-overview')).toBeHidden()
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
    await expect(page.locator('.archive-state-panel[data-kind="filtered"]')).toBeVisible()
    await page.getByRole('button', { name: '重置筛选', exact: true }).click()
    await expect(cards).toHaveCount(6)
    await pickStudioOptionByValue(page.getByLabel('按项目筛选'), 'review')
    await expect(cards).toHaveCount(2)
    await expect(page.getByRole('navigation', { name: '画册位置' })).toContainText('秋日手记')
    await page.getByRole('button', { name: '返回画册', exact: true }).click()
    await expect(page.locator('.gallery-album-overview')).toBeVisible()
    await expect(page.locator('.gallery-image-browse')).toBeHidden()
    const album = page.locator('.gallery-album[data-album-id="review"]')
    await expect(album).toBeFocused()
    await album.click()
    await expect(page.locator('.gallery-album-overview')).toBeHidden()
    await expect(cards).toHaveCount(2)
    await pickStudioOptionByValue(page.getByLabel('按项目筛选'), '')
    await expect(cards).toHaveCount(6)
    await cards.first().locator('.artwork-button').click()
    await expect(page.getByRole('dialog', { name: '作品观赏模式' })).toBeVisible()
    const viewer = page.getByRole('dialog', { name: '作品观赏模式' })
    await viewer.getByRole('button', {name:'春日',exact:true}).click()
    await expect(viewer).toBeHidden()
    await expect(cards).toHaveCount(2)
    await expect(page.getByLabel('按标签筛选')).toBeFocused()
    await page.getByRole('button',{name:'清除标签：春日'}).click()
    await expect(cards).toHaveCount(6)
    await cards.first().locator('.artwork-button').click()
    await expect(viewer.getByRole('link', { name: '沿用配方', exact: true })).toBeVisible()
    await expect(viewer.getByRole('button', { name: '下载原图', exact: true })).toBeVisible()
    await expect(viewer.getByRole('link', { name: '原参重跑', exact: true })).toBeHidden()
    await expect(viewer.locator('.viewer-facts')).toBeHidden()
    for (const selector of ['.viewer-title', '.viewer-meta', '.viewer-story', '.viewer-section h3', '.viewer-details summary']) {
      expect(await viewer.locator(selector).first().evaluate(textContrast), selector).toBeGreaterThanOrEqual(4.5)
    }
    await viewer.locator('.viewer-more summary').click()
    await expect(viewer.getByRole('link', { name: '原参重跑', exact: true })).toBeVisible()
    await viewer.locator('.viewer-details:not(.viewer-more) summary').click()
    await expect(viewer.locator('.viewer-facts')).toBeVisible()
    await viewer.getByRole('button', { name: '下一幅', exact: true }).click()
    await expect(viewer.locator('.viewer-facts')).toBeHidden()
    await expect(viewer.getByRole('link', { name: '原参重跑', exact: true })).toBeHidden()
    await viewer.getByRole('button', { name: '上一幅', exact: true }).click()
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

  test(`gallery narrow info drawer focus lifecycle ${theme}`, async ({ page }, testInfo) => {
    await seedGallery(page, theme)
    await page.setViewportSize({ width: 390, height: 960 })
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' })

    const opener = page.locator('.gallery-wall .artwork-button').first()
    await opener.click()
    const viewer = page.getByRole('dialog', { name: '作品观赏模式' })
    const toggle = viewer.locator('.viewer-info-toggle')
    const info = viewer.locator('.viewer-info')
    const infoClose = info.getByRole('button', { name: '关闭信息' })

    await expect(viewer).toBeVisible()
    await expect(info).toBeHidden()
    await expect(info).toHaveAttribute('inert', '')
    await expect(info).toHaveAttribute('aria-hidden', 'true')
    await expect(viewer.locator('.zoom-hint')).toBeHidden()
    await page.screenshot({ path: testInfo.outputPath(`gallery-viewer-${theme}-200.png`) })

    await toggle.click()
    await expect(info).toBeVisible()
    await expect(info).not.toHaveAttribute('inert', '')
    await expect(info).not.toHaveAttribute('aria-hidden', 'true')
    await expect(infoClose).toBeVisible()
    await expect(infoClose).toBeFocused()
    expect(await info.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`gallery-info-${theme}-200.png`) })

    await page.keyboard.press('Escape')
    await expect(viewer).toBeVisible()
    await expect(info).toBeHidden()
    await expect(toggle).toBeFocused()

    await toggle.click()
    await expect(infoClose).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(viewer.locator('.viewer-position')).toHaveText('2 / 6')
    await expect(info).toBeHidden()
    await expect(toggle).toBeFocused()

    await toggle.click()
    await expect(infoClose).toBeFocused()
    await viewer.locator('.viewer-close').evaluate((button: HTMLButtonElement) => button.click())
    await expect(viewer).toBeHidden()
    await expect(opener).toBeFocused()
  })

  test(`gallery responsive layout ${theme}`, async ({ page }, testInfo) => {
    await seedGallery(page, theme)
    for (const width of [1280, 820, 390]) {
      await page.setViewportSize({ width, height: 960 })
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const columns = page.locator('.gallery-columns').first()
      await expect(columns).toBeVisible()
      await expect.poll(() => columns.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length === el.querySelectorAll(':scope > .gallery-col').length)).toBe(true)
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
