import { expect, test } from '@playwright/test'

for (const theme of ['dark', 'light'] as const) {
  test(`creation guide hover keeps the card surface ${theme}`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.goto('/')
    const card = page.locator('.guide-steps a').first()
    await expect(card).toBeVisible()

    const before = await card.evaluate(element => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, border: style.borderColor }
    })
    await card.hover()
    await expect.poll(() => card.evaluate(element => getComputedStyle(element).transform)).not.toBe('none')
    const after = await card.evaluate(element => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, border: style.borderColor }
    })

    expect(after.background).toBe(before.background)
    expect(after.border).not.toBe(before.border)
    await page.screenshot({ path: `.review-shots/home-creation-hover-${theme}.png` })
  })
}
