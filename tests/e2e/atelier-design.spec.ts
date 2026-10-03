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
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await page.locator('.hero-character').first().evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s')
  const create = page.getByRole('link', { name: '选场景，开始创作', exact: true })
  const shortcuts = page.locator('.home-bento')
  const room = shortcuts.locator('.tool-card[href="/chat?character=natsume"]')
  await expect(shortcuts.getByRole('link')).toHaveCount(5)
  await expect(room).toHaveAttribute('href', '/chat?character=natsume')
  await create.click()
  await expect(page).toHaveURL(/\/scene-explorer$/)
  await expect(page.locator('.scene-grid .sc').first()).toBeVisible()
  await page.goBack()
  await page.getByRole('button', { name: '四季夏目', exact: true }).click()
  await room.click()
  await expect(page).toHaveURL(/\/chat\?character=natsume$/)
  await expect(page.locator('.portrait-stage')).toHaveAttribute('data-character', 'natsume')
})

test('adjusting a scene enters its workspace without submitting generation', async ({ page }) => {
  const submitted: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/(?:generation\/jobs|anima\/jobs|runtime-tasks)/.test(request.url())) submitted.push(request.url())
  })
  await openAtelier(page, '/scene-explorer')
  await page.locator('.scene-grid').getByRole('button', { name: '故事', exact: true }).first().click()
  const adjust = page.getByRole('dialog', { name: '场景故事', exact: true }).getByRole('link', { name: '开始绘制这一幕', exact: true })
  await expect(adjust).not.toHaveAttribute('href', /generate=1|quick=1/)
  await adjust.click()
  await expect(page.locator('.gen-bar')).toBeVisible()
  await page.locator('[aria-controls="material-story"]').click()
  await expect(page.locator('.scene-context-title')).toBeVisible()
  expect(submitted).toEqual([])
})

test('drawing invitation opens materials without starting generation', async ({ page }) => {
  let submissions = 0
  page.on('request', request => { if (request.method() === 'POST' && /anima\/jobs$/.test(request.url())) submissions++ })
  await openAtelier(page, '/prompt-builder')
  await page.locator('.stage-idle').getByRole('button', { name: '挑选场景', exact: true }).click()
  await expect(page).toHaveURL(/prompt-builder/)
  await expect(page.locator('#material-scenes')).toBeVisible()
  await expect(page.locator('[aria-controls="material-scenes"]')).toBeFocused()
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
