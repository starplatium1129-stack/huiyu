import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark']) test(`character references load only the selected profile (${theme})`, async ({ page }) => {
  await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
  const ids: string[] = []
  let fullLibraryRequests = 0
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/data/character-reference-view.json') fullLibraryRequests++
  })
  await page.route('**/api/character-reference-profile/*', async route => {
    const characterId = new URL(route.request().url()).pathname.split('/').at(-1)!
    ids.push(characterId)
    await route.fulfill({ json: { characterId, displayName: characterId, source: 'fixture', identityProse: '', outfits: [] } })
  })
  await page.goto('/character?character=katou_megumi')
  await expect(page.locator('.character-name')).toHaveText('加藤惠')
  await expect.poll(() => ids).toEqual(['katou_megumi'])
  const next = page.locator('.directory-item:not([data-character="katou_megumi"])').first()
  const nextId = await next.getAttribute('data-character')
  expect(nextId).toBeTruthy()
  await next.click()
  await expect.poll(() => ids).toEqual(['katou_megumi', nextId])
  await page.locator('.directory-item[data-character="katou_megumi"]').click()
  await expect(page.locator('.character-name')).toHaveText('加藤惠')
  expect(ids).toEqual(['katou_megumi', nextId])
  expect(fullLibraryRequests).toBe(0)
})
