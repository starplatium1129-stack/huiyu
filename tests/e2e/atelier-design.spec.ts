import { expect, test } from '@playwright/test'

async function openAtelier(page: import('@playwright/test').Page, route = '/') {
  await page.goto(route)
  const guide = page.getByRole('dialog', { name: '访客导览' })
  await expect(page.locator('main h1')).toBeVisible()
  await expect(guide).toBeHidden()
}

test('home character selection keeps artwork, caption and accent together', async ({ page }) => {
  await openAtelier(page)
  const hero = page.locator('.home-hero')
  await expect(hero).toHaveAttribute('data-muse', 'nene')
  await expect(hero.locator('.hero-character.is-current')).toHaveAttribute('alt', '绫地宁宁')
  const violet = await hero.evaluate(el => getComputedStyle(el).getPropertyValue('--accent'))
  const natsume = hero.getByRole('button', { name: '四季夏目', exact: true })
  await natsume.focus()
  await page.keyboard.press('Enter')
  await expect(natsume).toHaveAttribute('aria-pressed', 'true')
  await expect(hero.locator('.hero-character.is-current')).toHaveAttribute('alt', '四季夏目')
  await expect(hero.locator('.orbit-label')).toContainText('SHIKI NATSUME')
  const amber = await hero.evaluate(el => getComputedStyle(el).getPropertyValue('--accent'))
  expect(amber).not.toBe(violet)
  expect(await hero.locator('.hero-character.is-current').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(page.locator('.sakura-fall')).toHaveCount(0)
  await expect(page.locator('#continueCta')).toHaveAttribute('href', '/scene-explorer')
})

test('reduced motion stops character transitions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openAtelier(page)
  expect(await page.locator('.hero-character').first().evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s')
})




test('discovery companion selection displays matching readable artwork', async ({ page }) => {
  await openAtelier(page, '/scene-explorer')
  const atlas = page.locator('.scene-atlas')
  await atlas.getByRole('button', { name: '四季夏目', exact: true }).click()
  await expect(atlas).toHaveAttribute('data-companion', 'natsume')
  const portrait = atlas.locator('.scene-atlas-portrait img.current')
  await expect(portrait).toHaveAttribute('alt', '四季夏目')
  await expect.poll(() => portrait.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(atlas.locator('figcaption')).toContainText('今天的故事，由你来选')
  await expect(atlas.locator('canvas')).toHaveCount(0)
})

test('drawing invitation opens materials without starting generation', async ({ page }) => {
  let submissions = 0
  page.on('request', request => { if (request.method() === 'POST' && /anima\/jobs$/.test(request.url())) submissions++ })
  await openAtelier(page, '/prompt-builder')
  await page.locator('.stage-idle').getByRole('button', { name: '挑选场景', exact: true }).click()
  await expect(page).toHaveURL(/prompt-builder/)
  await expect(page.locator('#material-scenes')).toBeVisible()
  expect(submissions).toBe(0)
})


test('journal links fall back to scene settings when artwork is unavailable', async ({ page }) => {
  await page.route('**/scene-showcase/images/**', route => route.fulfill({ status: 404, body: '' }))
  await openAtelier(page)
  const entry = page.locator('.journal-entry').first()
  await expect(entry).toBeVisible()
  await expect(entry).toHaveAttribute('href', /scene-explorer\?scene=sc/)
  const href = await entry.getAttribute('href')
  await expect(entry).toContainText('查看场景设定')
  await entry.click()
  await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe(href)
  await expect(page.getByRole('dialog', { name: '样张查看器' })).toBeHidden()
})

test('selection motion settles on the final choice after rapid changes', async ({ page }) => {
  await openAtelier(page)
  const group = page.getByRole('group', { name: '首页角色视觉' })
  await group.getByRole('button', { name: '四季夏目', exact: true }).click()
  await group.getByRole('button', { name: '绫地宁宁', exact: true }).click()
  await group.getByRole('button', { name: '四季夏目', exact: true }).click()
  await expect.poll(async () => group.evaluate(el => {
    const active = el.querySelector('[aria-pressed="true"]')!.getBoundingClientRect()
    const indicator = el.querySelector('.animated-selection')!.getBoundingClientRect()
    return Math.abs(active.left - indicator.left) + Math.abs(active.width - indicator.width)
  })).toBeLessThan(2)
})

test('welcome guide is optional and keyboard dismissible', async ({ page }) => {
  await openAtelier(page)
  await page.locator('.nav-more-trigger').click()
  await page.getByRole('button', { name: '初次来访 · 使用指南' }).click()
  const dialog = page.getByRole('dialog', { name: '访客导览' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})
