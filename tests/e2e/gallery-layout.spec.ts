import { expect, test, type Page } from '@playwright/test'
import { textContrast } from './helpers/contrast'
import { pickStudioOptionByValue } from './helpers/studioSelect'

// Browser-local fixture: no personal artwork or generation endpoint is used.
async function seedGallery(page: Page, theme: string, empty = false, reducedMotion: 'reduce' | 'no-preference' = 'reduce', unfiled = false) {
  await page.route(/^http:\/\/[^/]+\/api\//, route => route.fulfill({ json: { ok: true, online: false } }))
  await page.route('**/assets/gallery-fixture-*', route => {
    const item = Number(route.request().url().split('-').at(-1))
    if (item === 3) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750"><rect width="1200" height="750" fill="#d5e1e2"/><circle cx="900" cy="220" r="80" fill="#f8e5bf"/><path d="M0 390Q300 270 600 410T1200 360V750H0Z" fill="#829ea4"/><path d="M0 580Q400 430 750 600T1200 500V750H0Z" fill="#4e737e"/></svg>' })
    const [width, height] = [[1200, 600], [600, 1200], [1024, 1024]][item % 3]
    return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#746687"/><circle cx="250" cy="250" r="140" fill="#d5e1e2"/><path d="M0 600L500 350L1200 800V1400H0Z" fill="#4e737e"/></svg>` })
  })
  await page.addInitScript(({ theme, empty, unfiled }) => {
    localStorage.setItem('aics_theme', theme)
    localStorage.setItem('aics_guest_guide_dismissed', '1')
    localStorage.setItem('aics_pb_history', JSON.stringify(empty ? [] : Array.from({ length: unfiled ? 40 : 6 }, (_, index) => ({
      id: `gallery-review-${index}`, sceneTitle: ['午后，和你', '光的形状', '一封写给秋日的长信：保留完整标题以验证小屏幕上的省略与布局', '雨后的街角', '海与她', '某个下午'][index],
      character: index % 2 ? 'nene' : 'natsume', prompt: 'Neutral UI review fixture',
      image_url: `/assets/gallery-fixture-${index}`, favorite: index < 2,
      parent_id: index === 0 ? 'gallery-review-1' : undefined,
      manual_tags: index < 2 ? ['春日'] : ['夜景'],
      timestamp: Date.now() - index * 1000,
      width: index === 3 ? 1200 : [1200, 600, 1024][index % 3],
      height: index === 3 ? 750 : [600, 1200, 1024][index % 3],
    }))))
    localStorage.setItem('aics_pb_projects', JSON.stringify(unfiled ? [] : [{ id: 'review', title: '秋日手记', history_ids: ['gallery-review-0', 'gallery-review-1'] }]))
  }, { theme, empty, unfiled })
  await page.emulateMedia({ reducedMotion })
  await page.goto('/gallery')
  await expect(page.getByRole('heading', { name: '我的作品', exact: true })).toBeVisible()
}

test('art walls reveal decoded cards once without blank HD frames', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await seedGallery(page, 'dark', false, 'no-preference', true)
  await page.route('**/scene-showcase/manifest.json', route => route.fulfill({ json: {
    entries: Array.from({ length: 48 }, (_, index) => ({ id: `flow-${index}`, title: `流动样张 ${index}`,
      char: 'nene', rating: 'All', type: 'scene', width: 832, height: 1216 })),
  } }))
  await page.route(/\/scene-showcase\/(images|thumbs)\/[^?]+/, route => route.fulfill({
    contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="832" height="1216"><rect width="832" height="1216" fill="#746687"/><circle cx="416" cy="360" r="140" fill="#d5e1e2"/></svg>',
  }))
  const results = []
  for (const [name, selector, wall] of [['gallery', '.artwork', '.gallery-wall'], ['showcase', '.sample', '.showcase-grid']] as const) {
    if (name === 'showcase') await page.getByRole('link', { name: '参考画册', exact: true }).first().click()
    const cards = page.locator(selector)
    await expect(cards.first()).toHaveCSS('opacity', '1')
    await expect(page.locator(wall)).toHaveCSS('opacity', '1')
    const pending = page.locator(`${selector}:not(.revealed)`).last()
    const key = await pending.getAttribute('data-reveal-key')
    const frames = await pending.evaluate(element => new Promise<Array<{ opacity: number; blank: boolean }>>(resolve => {
      const frames: Array<{ opacity: number; blank: boolean }> = []
      element.scrollIntoView({ block: 'center', behavior: 'instant' })
      const sample = () => {
        const opacity = Number(getComputedStyle(element).opacity)
        const hasImage = [...element.querySelectorAll<HTMLImageElement>('img')].some(img =>
          img.complete && img.naturalWidth > 0 && Number(getComputedStyle(img).opacity) > 0)
        frames.push({ opacity, blank: opacity > .05 && !hasImage })
        if (frames.length === 40) resolve(frames)
        else requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    }))
    expect(frames.some(frame => frame.opacity > 0 && frame.opacity < 1), name).toBe(true)
    expect(frames.some(frame => frame.blank), name).toBe(false)
    const seen = page.locator(`[data-reveal-key="${key}"]`)
    await expect(seen).toHaveCSS('opacity', '1')
    const decodedImage = seen.locator('img').first()
    if (name === 'gallery') await expect(seen.locator('.artwork-image-hd')).toHaveCSS('opacity', '1')
    const handle = await decodedImage.elementHandle()
    const src = await decodedImage.getAttribute('src')
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; scrollTo({ top: 0, behavior: 'instant' }) })
    await seen.scrollIntoViewIfNeeded()
    await expect(seen).toHaveCSS('transform', 'none')
    if (name === 'showcase') {
      await expect.poll(() => cards.count()).toBeGreaterThan(24)
      await page.getByRole('link', { name: '首页', exact: true }).first().click()
      await page.getByRole('link', { name: '参考画册', exact: true }).first().click()
      await expect(decodedImage).toHaveAttribute('src', src!)
      expect(await handle!.evaluate(image => image.isConnected)).toBe(true)
    }
    await page.screenshot({ path: info.outputPath(`${name}-flow-light.png`) })
    results.push({ page: name, frames, ...await page.evaluate(() => ({ cssViewport: [innerWidth, innerHeight],
      browserZoom: visualViewport?.scale, systemDpi: 'not sampled; isolated browser, not native WebView acceptance' })) })
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.sample').last()).toHaveCSS('opacity', '1')
  await expect(page.locator('.sample').last()).toHaveCSS('transform', 'none')
  await info.attach('art-wall-frames', { body: JSON.stringify(results), contentType: 'application/json' })
})

test('gallery orbit reverses continuously and keeps original zoom, pan and return focus', async ({ page }) => {
  await seedGallery(page, 'dark', false, 'no-preference')
  const opener = page.locator('[data-card-id="gallery-review-2"] .artwork-button')
  await opener.click()
  const viewer = page.locator('.art-viewer'), orbit = viewer.locator('.gallery-orbit')
  await expect(orbit).toBeVisible()
  await expect(viewer.locator('.gallery-orbit-neighbor')).toHaveCount(4)
  const positions = await viewer.evaluate(async host => {
    const surface = host.querySelector<HTMLElement>('.gallery-orbit')!
    host.querySelector<HTMLButtonElement>('.viewer-next')!.click()
    for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame)
    const before = Number(surface.dataset.position), samples: number[] = []
    host.querySelector<HTMLButtonElement>('.viewer-prev')!.click()
    for (let frame = 0; frame < 3; frame++) { await new Promise(requestAnimationFrame); samples.push(Number(surface.dataset.position)) }
    return { before, samples }
  })
  expect(positions.before).toBeGreaterThan(2)
  expect(positions.before).toBeLessThan(3)
  expect(positions.samples[0]).toBeGreaterThan(positions.before)
  await expect.poll(() => orbit.getAttribute('data-position')).toBe('2')
  await viewer.getByRole('button', { name:'原图 / 缩放', exact:true }).click()
  await expect(orbit).toHaveCount(0)
  const zoom = viewer.locator('.zoomable-image-viewer')
  await expect(zoom).toBeFocused()
  await page.keyboard.press('+')
  const layer = zoom.locator('.zoom-transform-layer'), beforePan = await layer.getAttribute('style')
  await page.keyboard.press('ArrowRight')
  expect(await layer.getAttribute('style')).not.toBe(beforePan)
  await expect(viewer.locator('.viewer-position')).toContainText('3 / 6')
  await page.keyboard.press('Home')
  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()
  await expect(opener).toBeFocused()
})

test('gallery bounded origin survives cold originals and interruptions', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await seedGallery(page, 'dark', false, 'no-preference')
  await expect(page.locator('[data-card-id]')).toHaveCount(6)
  let release!: () => void
  const originalReady = new Promise<void>(resolve => { release = resolve })
  await page.route('**/assets/gallery-origin-original', async route => {
    await originalReady
    await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="2000"><rect width="4000" height="2000" fill="#746687"/><circle cx="2900" cy="600" r="360" fill="#f8e5bf"/><path d="M0 1600L1400 500L2800 1500L4000 1000V2000H0Z" fill="#4e737e"/></svg>' })
  })
  // Add a real stored thumbnail; the original stays cold until explicitly released.
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('aics_kv_store', 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('kv', 'readwrite'), store = tx.objectStore('kv')
      const history = store.get('aics_pb_history')
      history.onsuccess = () => {
        const entries = history.result.value
        Object.assign(entries[0], { image_id: 'origin-cold', image_url: '/assets/gallery-origin-original', width: 4000, height: 2000 })
        store.put({key:'aics_pb_history',value:entries})
        store.put({key:'thumb:origin-cold',value:'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="560" height="280"><rect width="560" height="280" fill="#746687"/><circle cx="406" cy="84" r="50" fill="#f8e5bf"/><path d="M0 224L196 70L392 210L560 140V280H0Z" fill="#4e737e"/></svg>')})
      }
      tx.oncomplete = () => { db.close(); resolve() }; tx.onerror = tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }))
  await page.reload({ waitUntil: 'domcontentloaded' })
  const opener = page.locator('[data-card-id="gallery-review-0"] .artwork-button')
  const viewer = page.locator('.art-viewer'), proxy = page.locator('[data-image-origin-proxy]')
  await expect(opener.locator('.artwork-image:not(.artwork-image-hd)')).toBeVisible()
  const frames = await opener.evaluate(async (element: HTMLButtonElement) => {
    const frames: Array<{width:number; pixels:number; count:number; scroll:number}> = []
    element.focus({preventScroll:true}); element.click()
    const start = performance.now()
    while (performance.now() - start < 650) {
      await new Promise(requestAnimationFrame)
      const layer = document.querySelector<HTMLCanvasElement>('[data-image-origin-proxy]')
      if (layer) frames.push({width:layer.getBoundingClientRect().width,pixels:layer.width*layer.height,count:document.querySelectorAll('[data-image-origin-proxy]').length,scroll:scrollY})
    }
    return frames
  })
  expect(frames.length).toBeGreaterThan(2)
  expect(frames.at(-1)!.width - frames[0].width).toBeGreaterThan(100)
  expect(frames.every(frame => frame.pixels <= 1920*1080 && frame.count === 1 && frame.scroll === frames[0].scroll)).toBe(true)
  await expect(viewer.locator('.zoomable-img')).toHaveJSProperty('naturalWidth', 560)
  await info.attach('cold-original-flight', {body:JSON.stringify(frames),contentType:'application/json'})
  release()
  await expect(viewer.locator('.zoomable-img')).toHaveJSProperty('naturalWidth', 4000)
  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()
  await expect(opener).toBeFocused()

  await opener.click(); await expect(proxy).toHaveCount(1)
  await page.keyboard.press('Escape'); await expect(viewer).toBeHidden()
  await expect(proxy).toHaveCount(0)
  await opener.click(); await expect(proxy).toHaveCount(1)
  await page.keyboard.press('ArrowRight')
  await expect(proxy).toHaveCount(0)
  await expect(viewer.locator('.viewer-title')).toHaveText('光的形状')
  await expect(viewer.locator('.zoomable-img')).toHaveJSProperty('naturalWidth', 600)
  await page.keyboard.press('Escape'); await expect(viewer).toBeHidden()
  await opener.click(); await expect(proxy).toHaveCount(1)
  await page.setViewportSize({width:1280,height:800})
  await expect(proxy).toHaveCount(0)
  await expect(viewer.locator('.zoomable-img')).toHaveCSS('opacity','1')
  await page.keyboard.press('Escape'); await expect(viewer).toBeHidden()
  await opener.click(); await expect(proxy).toHaveCount(1)
  await page.emulateMedia({reducedMotion:'reduce'})
  await expect(proxy).toHaveCount(0)
  await page.keyboard.press('Escape'); await expect(viewer).toBeHidden()
  await opener.click(); await expect(proxy).toHaveCount(0)
  await page.keyboard.press('Escape'); await expect(viewer).toBeHidden()
  await page.emulateMedia({reducedMotion:'no-preference'})

  const viewports = []
  for (const theme of ['dark','light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme)
    for (const [width,height] of [[1920,1080],[2560,1440],[3840,2160]]) {
      await page.setViewportSize({width,height})
      await opener.click(); await expect(proxy).toHaveCount(1)
      const pixels = await proxy.evaluate((layer:HTMLCanvasElement) => layer.width*layer.height)
      expect(pixels).toBeLessThanOrEqual(1920*1080)
      await expect(proxy).toHaveCount(0)
      await expect(viewer).toHaveCSS('opacity','1')
      expect(await viewer.locator('.viewer-title').evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      await page.screenshot({path:info.outputPath(`gallery-origin-${theme}-${width}.png`)})
      viewports.push(await page.evaluate(pixels => ({cssViewport:[innerWidth,innerHeight],devicePixelRatio,browserZoom:visualViewport?.scale,pixels,physicalDisplay:'not sampled; isolated desktop browser'}),pixels))
      await page.keyboard.press('Escape'); await expect(viewer).toBeHidden()
    }
  }
  await info.attach('desktop-display-pixels',{body:JSON.stringify(viewports),contentType:'application/json'})
  await page.setViewportSize({width:960,height:700})
  await opener.click(); await expect(proxy).toHaveCount(0)
  await page.evaluate(() => scrollTo(0,document.documentElement.scrollHeight))
  await expect(opener).not.toBeInViewport()
  const beforeClose = await page.evaluate(() => scrollY)
  await page.keyboard.press('Escape'); await expect(viewer).toBeHidden()
  expect(await page.evaluate(() => scrollY)).toBe(beforeClose)
  await expect(opener).not.toBeFocused()
  await opener.scrollIntoViewIfNeeded()
  await page.route('**/assets/gallery-origin-broken', route => route.fulfill({status:404,body:''}))
  await opener.click(); await expect(proxy).toHaveCount(1)
  await viewer.locator('.zoomable-img').evaluate((image:HTMLImageElement) => { image.src = '/assets/gallery-origin-broken' })
  await expect(proxy).toHaveCount(0)
  await expect(viewer.locator('.viewer-fallback')).toBeVisible()
  await page.keyboard.press('Escape'); await expect(viewer).toBeHidden()
  expect(errors).toEqual([])
})

for (const theme of ['light', 'dark']) {
  test(`gallery role albums and smart rule lifecycle ${theme}`, async ({ page }, info) => {
    await seedGallery(page, theme)
    await page.getByRole('button', { name: /^按角色/ }).click()
    const role = page.getByRole('button', {name:'四季夏目，3 幅作品',exact:true})
    await expect(role).toBeVisible()
    const viewports = []
    for (const [width,height] of [[1920,1080],[2560,1440],[3840,2160],[960,900]]) {
      await page.setViewportSize({width,height})
      await expect(role).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      for (const label of await page.locator('.gallery-album-caption strong, .gallery-album-caption small').all()) expect(await label.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      viewports.push(await page.evaluate(() => ({scope:'roles',cssViewport:[innerWidth,innerHeight],devicePixelRatio,visualViewportScale:visualViewport?.scale,physicalDisplay:'not sampled in isolated browser'})))
      await page.screenshot({path:info.outputPath(`role-albums-${theme}-${width}.png`)})
    }
    await role.click()
    await expect(page.locator('[data-card-id]')).toHaveCount(3)
    await expect(page).toHaveURL(/character=natsume/)
    await page.reload()
    await expect(page.locator('.gallery-count strong')).toHaveText('四季夏目')
    await expect(page.locator('[data-card-id]')).toHaveCount(3)
    await pickStudioOptionByValue(page.getByRole('combobox', {name:'按标签筛选',exact:true}), '春日')
    await page.getByRole('button', {name:/^收藏 /}).click()
    await expect(page.locator('[data-card-id]')).toHaveCount(1)
    await page.getByRole('button', {name:'保存为智能画册',exact:true}).click()
    const editor = page.getByRole('dialog', {name:'新建智能画册',exact:true})
    await expect(editor).toContainText('当前匹配 1 幅作品')
    await editor.getByRole('textbox', {name:'画册名称',exact:true}).fill('夏目的春日精选')
    await pickStudioOptionByValue(editor.getByRole('combobox', {name:'添加画册标签',exact:true}), '夜景')
    await expect(editor).toContainText('当前匹配 0 幅作品')
    await pickStudioOptionByValue(editor.getByRole('combobox', {name:'标签匹配方式',exact:true}), 'any')
    await expect(editor).toContainText('当前匹配 1 幅作品')
    await pickStudioOptionByValue(editor.getByRole('combobox', {name:'智能画册作品范围',exact:true}), 'review')
    await pickStudioOptionByValue(editor.getByRole('combobox', {name:'智能画册作品范围',exact:true}), '')
    await editor.getByRole('button', {name:'移除标签：夜景',exact:true}).click()
    for (const [width,height] of [[1920,1080],[2560,1440],[3840,2160],[960,900]]) {
      await page.setViewportSize({width,height})
      await expect(editor.getByRole('button', {name:'保存智能画册',exact:true})).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      for (const text of await editor.locator('.smart-album-field > span, .smart-album-name > span, .smart-album-note, .smart-album-preview strong, .smart-album-favorite').all()) {
        expect(await text.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      }
      await pickStudioOptionByValue(editor.getByRole('combobox', {name:'智能画册角色',exact:true}), 'natsume')
      viewports.push(await page.evaluate(() => ({scope:'editor',cssViewport:[innerWidth,innerHeight],devicePixelRatio,visualViewportScale:visualViewport?.scale,physicalDisplay:'not sampled in isolated browser'})))
      await page.screenshot({path:info.outputPath(`smart-editor-${theme}-${width}.png`)})
    }
    await info.attach('smart-album-viewports',{body:JSON.stringify(viewports),contentType:'application/json'})
    await editor.getByRole('button', {name:'保存智能画册',exact:true}).click()
    await expect(editor).toBeHidden()
    await expect(page.locator('.gallery-count strong')).toHaveText('夏目的春日精选')
    await expect(page).toHaveURL(/project=smart-/)
    await page.reload()
    await expect(page.locator('[data-card-id]')).toHaveCount(1)
    const work = page.locator('[data-card-id="gallery-review-0"]')
    await work.hover()
    await work.getByRole('button', {name:/取消收藏/}).click()
    await expect(page.locator('[data-card-id]')).toHaveCount(0)
    await page.getByRole('button', {name:/^按画册/}).click()
    await expect(page.getByRole('button',{name:'夏目的春日精选，0 幅作品',exact:true})).toBeVisible()
    await page.screenshot({path:info.outputPath(`smart-albums-${theme}.png`)})
    await page.getByRole('button',{name:'编辑智能画册：夏目的春日精选',exact:true}).click()
    const editing = page.getByRole('dialog',{name:'编辑智能画册',exact:true})
    await editing.getByRole('button',{name:/仅收录收藏的作品/}).click()
    await expect(editing).toContainText('当前匹配 1 幅作品')
    await editing.getByRole('button',{name:'更新智能画册',exact:true}).click()
    await expect(page.locator('[data-card-id]')).toHaveCount(1)
    await page.getByRole('button',{name:/^按画册/}).click()
    await page.getByRole('button',{name:'移除智能画册：夏目的春日精选',exact:true}).click()
    await page.getByRole('alertdialog').getByRole('button',{name:'移除画册',exact:true}).click()
    await expect(page.getByRole('button',{name:/夏目的春日精选，/})).toHaveCount(0)
    await page.getByRole('button',{name:'全部作品',exact:true}).click()
    await expect(page.locator('[data-card-id]')).toHaveCount(6)
    await expect(page).toHaveURL(/\/gallery$/)
    await page.reload()
    await expect(page.locator('[data-card-id]')).toHaveCount(6)
  })
  test(`gallery creates an album from 40 existing artworks ${theme}`, async ({ page }, info) => {
    await seedGallery(page, theme, false, 'reduce', true)
    await expect(page.locator('[data-card-id]')).toHaveCount(40)
    await page.getByRole('button', { name: /^按画册/ }).click()
    await expect(page.getByText('还没有成册的作品', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '选择作品成册', exact: true }).click()
    await page.getByRole('button', { name: '全选当前', exact: true }).click()
    await page.locator('.gallery-organization').getByRole('button', { name: '新建画册', exact: true }).click()
    await page.getByRole('textbox', { name: '画册名称', exact: true }).fill('四十幅创作手记')
    const create = page.getByRole('button', { name: '创建画册并加入 40 幅作品', exact: true })
    const viewports = []
    for (const [width, height] of [[1920, 1080], [2560, 1440], [3840, 2160], [960, 900]]) {
      await page.setViewportSize({ width, height })
      await create.scrollIntoViewIfNeeded()
      await expect(create).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await create.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      for (const label of await page.locator('.organization-field > span, .organization-note').all()) {
        expect(await label.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      }
      viewports.push(await page.evaluate(() => ({ cssViewport: [innerWidth, innerHeight], devicePixelRatio,
        visualViewportScale: visualViewport?.scale, physicalDisplay: 'not sampled in isolated browser' })))
      await page.screenshot({ path: info.outputPath(`album-create-${theme}-${width}.png`) })
    }
    await info.attach('browser-viewports', { body: JSON.stringify(viewports), contentType: 'application/json' })
    await create.click()
    await expect(page.locator('.gallery-organization')).toContainText('已整理 40 幅作品')
    await page.getByRole('region', { name: '批量操作' }).getByRole('button', { name: '完成', exact: true }).click()
    await page.getByRole('button', { name: /^按画册/ }).click()
    const album = page.getByRole('button', { name: '四十幅创作手记，40 幅作品', exact: true })
    await expect(album).toBeVisible()
    await album.click()
    await expect(page.locator('.gallery-count strong')).toHaveText('四十幅创作手记')
    await expect(page).toHaveURL(/project=album-/)
    await page.reload()
    await expect(page.locator('.gallery-count strong')).toHaveText('四十幅创作手记')
    await expect(page.locator('[data-card-id]')).toHaveCount(40)
    await page.screenshot({ path: info.outputPath(`album-open-${theme}.png`) })
  })
  test(`gallery trash styled restoration and confirmed clearing ${theme}`, async ({ page }, info) => {
    await seedGallery(page, theme)
    await page.getByRole('button', { name: '选择', exact: true }).click()
    await page.locator('[data-card-id="gallery-review-0"] .artwork-button').click()
    await page.locator('[data-card-id="gallery-review-1"] .artwork-button').click()
    await page.getByRole('button', { name: '移入回收站（2）', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '移入回收站', exact: true }).click()
    await page.getByRole('group', { name: '管理作品' }).getByRole('button', { name: /回收站/ }).click()
    await expect(page.locator('.trash-card')).toHaveCount(2)
    const restore = page.getByRole('button', { name: /恢复作品/ }).first()
    const clear = page.getByRole('button', { name: '清空回收站', exact: true })
    for (const [width, height] of [[1920, 1080], [2560, 1440], [3840, 2160], [960, 900]]) {
      await page.setViewportSize({ width, height })
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await expect(clear).toBeInViewport()
      await expect(restore).toBeInViewport()
      expect(await restore.evaluate(el => parseFloat(getComputedStyle(el).borderRadius))).toBeGreaterThanOrEqual(4)
      expect(await restore.evaluate(el => parseFloat(getComputedStyle(el).minHeight))).toBeGreaterThanOrEqual(32)
      for (const control of [restore, clear, page.locator('.trash-hint'), page.locator('.trash-count')]) {
        expect(await control.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
      }
      await page.screenshot({ path: info.outputPath(`trash-${theme}-${width}.png`) })
    }
    await clear.click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('无法从回收站恢复')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.locator('.trash-card')).toHaveCount(2)
    await restore.click()
    await expect(page.locator('.trash-card')).toHaveCount(1)
    await clear.click()
    await dialog.getByRole('button', { name: '永久清空', exact: true }).click()
    await expect(page.locator('.trash-card')).toHaveCount(0)
    await expect(clear).toBeDisabled()
    expect(await clear.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
    await page.getByRole('button', { name: '全部作品', exact: true }).click()
    await expect(page.locator('[data-card-id]')).toHaveCount(5)
    await info.attach('viewport', { body: JSON.stringify(await page.evaluate(() => ({ cssWidth: innerWidth, cssHeight: innerHeight, devicePixelRatio, visualScale: visualViewport?.scale }))), contentType: 'application/json' })
  })
  if (theme === 'dark') test(`gallery preview keeps real images through the closing fade ${theme}`, async ({ page }, testInfo) => {
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
              const image = document.querySelector<HTMLImageElement>('.art-viewer .zoomable-img')!
              const target = image.getBoundingClientRect(), fit = Math.min(target.width / image.naturalWidth, target.height / image.naturalHeight)
              const width = image.naturalWidth * fit, height = image.naturalHeight * fit
              return { frames, sourceWidth: source.width, targetWidth: width, targetLeft: target.left + (target.width - width) / 2, targetTop: target.top + (target.height - height) / 2 }
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
    for (const [name, ratio] of [['午后，和你', 2], ['光的形状', 0.5]] as const) {
      const artwork = cards.filter({ has: page.getByRole('button', { name: `欣赏作品：${name}`, exact: true }) })
      await expect.poll(() => artwork.locator('.artwork-media').evaluate(element => {
        const parts = getComputedStyle(element).aspectRatio.split('/').map(Number)
        return parts[0] / (parts[1] || 1)
      })).toBeCloseTo(ratio, 1)
    }
    await expect(page.locator('.gallery-album-overview')).toBeHidden()
    await expect(page.locator('.artwork-image.is-loaded').first()).toBeVisible()
    await expect(page.getByRole('link', { name: '新建创作', exact: true })).toHaveAttribute('href', '/prompt-builder')
    const media = await cards.first().locator('.artwork-media').boundingBox()
    const caption = await cards.first().locator('.artwork-caption').boundingBox()
    expect(caption!.y).toBeGreaterThanOrEqual(media!.y + media!.height - 1)
    for (const selector of ['.artwork-name', '.artwork-date', '.gallery-title', '.gallery-count', '.gallery-filter.active']) {
      expect(await page.locator(selector).first().evaluate(textContrast), selector).toBeGreaterThanOrEqual(4.5)
    }
    await page.screenshot({ path: testInfo.outputPath(`gallery-${theme}.png`), fullPage: true })
    const selectedCard = page.locator('[data-card-id="gallery-review-0"]')
    await page.getByRole('button', { name: '选择', exact: true }).click()
    await expect(cards.locator('.artwork-check')).toHaveCount(6)
    await expect(cards.locator('.artwork-tools')).toHaveCount(0)
    await expect(selectedCard.locator('.artwork-button')).toHaveAttribute('aria-pressed', 'false')
    await selectedCard.locator('.artwork-button').click()
    await expect(selectedCard.locator('.artwork-button')).toHaveAttribute('aria-pressed', 'true')
    await expect(selectedCard.locator('.artwork-check .archive-icon')).toBeVisible()
    await page.locator('[data-card-id="gallery-review-1"] .artwork-button').click()
    await page.getByRole('button', { name: '移入回收站（2）', exact: true }).click()
    const deleteDialog = page.getByRole('alertdialog')
    await expect(deleteDialog).toContainText('把 2 幅作品移入回收站？')
    await deleteDialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(deleteDialog).toBeHidden()
    await expect(cards).toHaveCount(6)
    await expect(selectedCard.locator('.artwork-button')).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: '退出选择', exact: true }).click()
    await expect(page.getByRole('button', { name: '选择', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await expect(cards.locator('.artwork-check')).toHaveCount(0)
    await selectedCard.hover()
    await selectedCard.getByRole('button', { name: '删除作品：午后，和你', exact: true }).click()
    await expect(selectedCard.getByRole('button', { name: '确认删除', exact: true })).toBeVisible()
    await selectedCard.getByRole('button', { name: '取消', exact: true }).click()
    await expect(selectedCard.getByRole('button', { name: '确认删除', exact: true })).toHaveCount(0)
    await expect(cards).toHaveCount(6)
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
    await pickStudioOptionByValue(page.getByLabel('按画册筛选'), 'review')
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
    await pickStudioOptionByValue(page.getByLabel('按画册筛选'), '')
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
    for (const selector of ['.viewer-title', '.viewer-meta', '.viewer-details summary']) {
      const text = viewer.locator(selector).first()
      await expect(text).toBeVisible()
      expect(await text.evaluate(textContrast), selector).toBeGreaterThanOrEqual(4.5)
    }
    for (const text of await viewer.locator('.viewer-story:visible, .viewer-section h3:visible').all()) {
      expect(await text.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
    }
    await viewer.locator('.viewer-more summary').click()
    await expect(viewer.getByRole('link', { name: '原参重跑', exact: true })).toBeVisible()
    await viewer.locator('.viewer-details:not(.viewer-more) summary').click()
    await expect(viewer.locator('.viewer-facts')).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect(viewer.locator('.viewer-position')).toHaveText('2 / 6')
    await expect(viewer.locator('.viewer-facts')).toBeHidden()
    await expect(viewer.getByRole('link', { name: '原参重跑', exact: true })).toBeHidden()
    await viewer.getByRole('button', { name: '上一幅', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(cards.first().locator('.artwork-button')).toBeFocused()
  })

  test(`gallery responsive layout ${theme}`, async ({ page }, testInfo) => {
    await seedGallery(page, theme)
    for (const width of [1280]) {
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

  test(`gallery organization undo and synchronized detail comparison ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await seedGallery(page, theme)
    const cards = page.locator('.artwork')
    await expect(cards).toHaveCount(6)
    await page.getByRole('button', { name: '选择', exact: true }).click()
    await page.locator('[data-card-id="gallery-review-2"] .artwork-button').click()
    await page.locator('[data-card-id="gallery-review-3"] .artwork-button').click()
    await page.getByRole('button', { name: '整理画册与标签', exact: true }).click()
    await pickStudioOptionByValue(page.getByRole('combobox', { name: '整理到画册', exact: true }), 'album:review')
    await page.getByLabel('添加整理标签', { exact: true }).fill('验收标签')
    await page.screenshot({ path: info.outputPath('gallery-organization-form.png') })
    for (const control of await page.locator('.organization-form label, .organization-note, .organization-form button').all()) {
      expect(await control.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
    }
    await page.getByRole('button', { name: '整理 2 幅作品', exact: true }).click()
    await expect(page.getByRole('button', { name: '撤销本次整理', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '退出选择', exact: true }).click()
    await pickStudioOptionByValue(page.getByRole('combobox', { name: '按画册筛选', exact: true }), 'review')
    await expect(cards).toHaveCount(4)
    await page.getByRole('button', { name: '撤销本次整理', exact: true }).click()
    await expect(cards).toHaveCount(2)
    await pickStudioOptionByValue(page.getByRole('combobox', { name: '按画册筛选', exact: true }), '')
    await expect(cards).toHaveCount(6)
    await page.getByRole('button', { name: '选择', exact: true }).click()
    await page.locator('[data-card-id="gallery-review-0"] .artwork-button').click()
    await page.locator('[data-card-id="gallery-review-1"] .artwork-button').click()
    await page.getByRole('button', { name: '对比挑选（2–4 张）', exact: true }).click()
    const compare = page.getByRole('dialog', { name: '对比挑选', exact: true })
    const viewports = compare.locator('.candidate-viewport')
    await expect(viewports).toHaveCount(2)
    await expect(viewports.first().locator('img')).toBeVisible()
    await viewports.first().focus()
    await viewports.first().press('+')
    await expect(viewports.nth(0)).toHaveAttribute('data-zoomed', 'true')
    await expect(viewports.nth(1)).toHaveAttribute('data-zoomed', 'true')
    await viewports.first().press('ArrowRight')
    const transforms = await viewports.locator('img').evaluateAll(images => images.map(image => (image as HTMLElement).style.getPropertyValue('--candidate-transform')))
    expect(transforms[0]).toBe(transforms[1])
    await compare.getByRole('button', { name: '同步缩放与移动', exact: true }).click()
    await viewports.first().press('Home')
    await expect(viewports.nth(0)).not.toHaveAttribute('data-zoomed', 'true')
    await expect(viewports.nth(1)).toHaveAttribute('data-zoomed', 'true')
    await compare.getByRole('button', { name: '复位全部画面', exact: true }).click()
    await expect(viewports.nth(1)).not.toHaveAttribute('data-zoomed', 'true')
    await compare.getByRole('button', { name: '只看差异参数', exact: true }).click()
    await expect(compare.locator('.candidate-parameters')).toHaveCount(2)
    await page.screenshot({ path: info.outputPath('gallery-synchronized-comparison.png') })
    for (const selector of ['.candidate-controls button', '.candidate-meta', '.candidate-parameters dt', '.candidate-parameters dd']) {
      for (const text of await compare.locator(selector).all()) expect(await text.evaluate(textContrast)).toBeGreaterThanOrEqual(4.5)
    }
    await page.keyboard.press('Escape')
    await expect(compare).not.toBeVisible()
  })

  if (theme === 'dark') test(`gallery empty state ${theme}`, async ({ page }, testInfo) => {
    await seedGallery(page, theme, true)
    await expect(page.getByText('展墙还在等你的第一幅作品')).toBeVisible()
    await expect(page.getByRole('link', { name: '开始绘制', exact: true })).toHaveAttribute('href', '/prompt-builder')
    await page.screenshot({ path: testInfo.outputPath(`gallery-empty-${theme}.png`) })
  })
}
