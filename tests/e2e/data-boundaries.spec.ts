import { expect, test } from '@playwright/test'

for (const theme of ['dark', 'light']) {
  test(`future chat remains byte-identical after navigation and reload ${theme}`, async ({ page, context }) => {
    const original = '{ "version": 999, "sentinel": "neutral-future", "histories": {"raiden_shogun": []} }'
    await page.goto('/')
    await page.evaluate(({ original, theme }) => {
      localStorage.setItem('aics_chat_v1', original)
      localStorage.setItem('aics_theme', theme)
    }, { original, theme })
    await page.goto('/chat')
    await expect(page.getByText(/聊天数据版本不兼容或已损坏/).first()).toBeVisible()
    await page.screenshot({ path: `runtime/audit-011/b1-${theme}.png`, fullPage: true })
    const second = await context.newPage()
    await second.goto('/chat?character=natsume')
    await page.goto('/settings')
    await page.goto('/chat')
    await page.reload()
    expect(await page.evaluate(() => localStorage.getItem('aics_chat_v1'))).toBe(original)
    expect(await page.evaluate(() => localStorage.getItem('aics_retired_companion_chat_v1'))).toBeNull()
    await second.close()
  })
}
