import { expect, test } from '@playwright/test'

for (const theme of ['dark']) for (const width of [1280, 1920]) {
  test(`full popular scene list scrolls to its last item ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 })
    await page.addInitScript(t => localStorage.setItem('aics_theme', t), theme)
    await page.goto('/prompt-builder?popular=makinohara_shouko')
    await expect(page.locator('.pb')).toHaveAttribute('data-character', 'makinohara_shouko')
    await page.getByRole('button', { name: '专家模式', exact: true }).click()
    await expect(page.locator('.pb')).toHaveAttribute('data-director-mode', 'pro')
    await page.locator('[aria-controls="material-scenes"]').click()
    await page.getByRole('button', { name: '查看全部', exact: true }).click()
    const cards = page.locator('.blueprint-card')
    await expect.poll(() => cards.count()).toBeGreaterThan(6)
    await cards.first().hover()
    await page.mouse.wheel(0, 3000)
    await expect(cards.last()).toBeInViewport({ ratio: .9 })
    await expect(page.locator('.material-switch')).toBeInViewport({ ratio: 1 })
    const scroller = page.locator('#material-scenes')
    expect(await scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
    await page.screenshot({ path: `runtime/scene-scroll-${theme}-${width}.png` })
    // Selection itself is checked with a safe scene; no generation is submitted.
    const safe = page.locator('.blueprint-card[data-adult="false"]').last()
    await safe.click()
    await expect(safe).toHaveAttribute('aria-pressed', 'true')
  })
}

test(`character archive retains identity speech and completed profile fields dark`, async ({ page }) => {
  const theme = 'dark'
  await page.addInitScript(t => localStorage.setItem('aics_theme', t), theme)
  await page.goto('/character?character=makinohara_shouko')
  await expect(page.locator('.identity-row')).toContainText('牧之原翔子')
  await expect(page.locator('.voice-block')).toContainText('今天也有值得好好记住的小事呢')
  for (const id of ['shiina_mashiro', 'izumi_sagiri', 'takarada_rikka', 'hayasaka_ai', 'arima_kana', 'hori_kyouko']) {
    await page.goto(`/character?character=${id}`)
    const likes = page.locator('.detail-section').filter({ hasText: '喜欢的事' })
    await expect(likes.locator('.chip').first()).toBeVisible()
    expect(await page.locator('.chip.trait').count()).toBe(3)
    await expect(page.locator('.voice-block')).toBeVisible()
  }
  await page.goto('/character?character=nene')
  await expect(page.locator('.identity-row .item')).toHaveCount(4)
  await expect(page.locator('.char-lora').first()).toContainText('ayachi_nene_v18_wd14')
  await page.screenshot({ path: `runtime/character-profile-restored-${theme}.png`, fullPage: true })
})
