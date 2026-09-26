import { expect, test, type Page } from '@playwright/test'
import { installShowcaseFixture } from './helpers/showcase'
import { pickStudioOptionByValue } from './helpers/studioSelect'

async function seedWork(page: Page, id: number, title: string) {
  await page.evaluate(async ({ id, title }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('aics_kv_store', 1)
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv', { keyPath: 'key' }) }
      request.onsuccess = () => {
        const db = request.result; const tx = db.transaction('kv', 'readwrite')
        tx.objectStore('kv').put({ key: 'aics_pb_history', value: [{ id, sceneTitle: title, story: title, scene: 'sc001', character: 'nene', timestamp: Date.now(), prompt: 'a quiet classroom', negative: '', size: '832x1216' }] })
        tx.oncomplete = () => { db.close(); resolve() }; tx.onerror = () => reject(tx.error)
      }
      request.onerror = () => reject(request.error)
    })
  }, { id, title })
}

test('home keeps the correct bundled covers even with an older external home manifest', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.hero-character.nene')).toHaveAttribute('src', '/assets/characters/nene-home-cg-1024.webp')
  await page.getByRole('button', { name: '四季夏目', exact: true }).click()
  await expect(page.locator('.hero-character.is-current')).toHaveAttribute('src', '/assets/characters/natsume-home-cg-1024.webp')
  await expect.poll(() => page.locator('.hero-character.is-current').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
})

test('global search routes saved work to history and refreshes its index on reopen', async ({ page }) => {
  await page.goto('/')
  await seedWork(page, 424201, '桌面检索回归甲')
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox', { name: '搜索场景、作品或页面' }).fill('桌面检索回归甲')
  await page.getByRole('option').filter({ hasText: '桌面检索回归甲' }).click()
  await expect(page).toHaveURL(/regen=424201/)
  await page.locator('[aria-controls="material-story"]').click()
  await expect(page.locator('.story-input')).toHaveValue('桌面检索回归甲')
  await seedWork(page, 424202, '桌面检索回归乙')
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox', { name: '搜索场景、作品或页面' }).fill('桌面检索回归乙')
  await page.getByRole('option').filter({ hasText: '桌面检索回归乙' }).click()
  await expect(page).toHaveURL(/regen=424202/)
  await page.locator('[aria-controls="material-story"]').click()
  await expect(page.locator('.story-input')).toHaveValue('桌面检索回归乙')
})

test('canvas scene selection stays in the working view and focuses the scene tab', async ({ page }) => {
  await page.goto('/prompt-builder')
  await page.locator('.stage-idle').getByRole('button', { name: '挑选场景', exact: true }).click()
  await expect(page).toHaveURL(/prompt-builder$/)
  await expect(page.locator('#material-scenes')).toBeVisible()
  await expect(page.locator('[aria-controls="material-scenes"]')).toBeFocused()
})

test('popular CG handoff keeps its character and blueprint, and back restores filters', async ({ page }) => {
  await installShowcaseFixture(page)
  let jobs = 0
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/anima/jobs')) jobs++ })
  await page.goto('/showcase')
  await page.locator('.showcase-filters > summary').press('Enter')
  await pickStudioOptionByValue(page.getByLabel('筛选作品类型'), 'popular')
  await page.getByRole('combobox', { name:'筛选角色', exact:true }).fill('雷电')
  await page.getByRole('option', { name:'雷电将军', exact:true }).click()
  await page.getByRole('searchbox', { name: '搜索画册' }).fill('天守阁')
  await expect(page.locator('.sample-title').first()).toContainText('天守阁')
  await page.getByRole('button', { name: '查看 雷电将军 · 天守阁内廷 大图', exact: true }).click()
  const link = page.getByRole('dialog', { name: '样张查看器' }).getByRole('link', { name: '使用这个角色场景' })
  await expect(link).toHaveAttribute('href', /popular=raiden_shogun&blueprint=raiden_shogun_tenshukaku/)
  await link.click()
  await expect(page.locator('.pb')).toHaveAttribute('data-character', 'raiden_shogun')
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await page.goBack()
  await expect(page.getByRole('searchbox', { name: '搜索画册' })).toHaveValue('天守阁')
  await expect(page.getByRole('combobox', { name:'筛选角色', exact:true })).toHaveValue('雷电将军')
  await page.getByRole('button', { name: '清除筛选' }).click()
  await expect(page.getByRole('searchbox', { name: '搜索画册' })).toHaveValue('')
  expect(jobs).toBe(0)
})

test('closing a linked CG clears its URL and does not reopen on reload', async ({ page }) => {
  await installShowcaseFixture(page)
  await page.goto('/showcase?scene=sc001')
  const dialog = page.getByRole('dialog', { name: '样张查看器' })
  await expect(dialog).toBeVisible()
  await expect.poll(() => dialog.locator('.zoomable-img').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/showcase$/)
  await page.reload()
  await expect(page.locator('.sample-visual').first()).toBeVisible()
  await expect(page.getByRole('dialog', { name: '样张查看器' })).toBeHidden()
})

test('a failed media load can be retried in place', async ({ page }) => {
  const fixture = await installShowcaseFixture(page, { failFirst: true })
  await page.goto('/showcase')
  await page.getByRole('button', { name: '重新读取样张' }).click()
  await expect.poll(() => fixture.requests()).toBe(2)
  await expect(page.locator('.sample-visual').first()).toBeVisible()
})

test('showcase thumbnails reserve their declared dimensions before decoding', async ({ page }) => {
  await installShowcaseFixture(page)
  await page.goto('/showcase')
  const visual = page.locator('.sample-visual').first()
  await expect(visual).toBeVisible()
  const geometry = await visual.evaluate(element => {
    const image = element.querySelector('img') as HTMLImageElement | null
    const style = getComputedStyle(element)
    const ratio = style.aspectRatio.split('/').map(value => Number(value.trim()))
    return {
      aspectRatio: ratio[1] ? ratio[0] / ratio[1] : Number(style.aspectRatio),
      width: image?.getAttribute('width'),
      height: image?.getAttribute('height'),
    }
  })
  expect(geometry.aspectRatio).toBeCloseTo(832 / 1216, 3)
  expect(geometry.width).toBe('832')
  expect(geometry.height).toBe('1216')
})

test('showcase thumbnails without declared dimensions keep the image natural ratio', async ({ page }) => {
  await installShowcaseFixture(page)
  await page.goto('/showcase')
  const visual = page.locator('.sample-visual').nth(1)
  await expect(visual).toBeVisible()
  await expect(visual.locator('.sample-image-ready')).toHaveCount(1)
  const geometry = await visual.evaluate(element => {
    const image = element.querySelector('img') as HTMLImageElement | null
    const box = element.getBoundingClientRect()
    const frame = image?.getBoundingClientRect()
    return {
      aspectRatio: getComputedStyle(element).aspectRatio,
      hasDeclaredSize: image?.hasAttribute('width') || image?.hasAttribute('height'),
      boxWidth: box.width,
      boxHeight: box.height,
      imageWidth: frame?.width ?? 0,
      imageHeight: frame?.height ?? 0,
    }
  })
  // 未声明尺寸不得凭空锁比例，否则 0.684 / 横构图的真实样张会被加留白边
  expect(geometry.aspectRatio).toBe('auto')
  expect(geometry.hasDeclaredSize).toBe(false)
  expect(geometry.imageWidth).toBeCloseTo(geometry.boxWidth, 0)
  expect(geometry.imageHeight).toBeCloseTo(geometry.boxHeight, 0)
})

test('character names can be found directly and selected with Enter', async ({ page }) => {
  await page.goto('/popular-scenes')
  await page.getByRole('searchbox', { name: '搜索角色或作品' }).fill('芙莉莲')
  await expect(page.locator('.directory-label strong').first()).toHaveText('芙莉莲')
  await page.getByRole('searchbox', { name: '搜索角色或作品' }).press('Enter')
  await expect(page.locator('.directory-item').first()).toHaveAttribute('aria-pressed', 'true')
})
