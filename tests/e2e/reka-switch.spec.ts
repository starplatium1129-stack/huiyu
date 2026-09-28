import { expect, test } from '@playwright/test'

for (const theme of ['dark']) {
  test(`Reka switches support keyboard and preserve preference state · ${theme}`, async ({ page }) => {
    await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
    // This test exercises local preferences only; never starts a real service.
    await page.route('**/api/**', route => route.fulfill({ json: { ok: false, error: 'Isolated UI fixture' } }))
    await page.goto('/control')
    const share = page.getByRole('switch', { name: '开启公网分享通道' })
    await expect(share).toBeVisible()
    const shareBox = await share.boundingBox()
    expect(shareBox && shareBox.width >= 44 && shareBox.height >= 44).toBe(true)
    const initial = await share.isChecked()
    await share.focus()
    await share.press('Space')
    await expect(share).toBeChecked({ checked: !initial })
    await share.press('Enter')
    await expect(share).toBeChecked({ checked: initial })
    const voice = page.getByRole('switch', { name: /打开控制面板时自动启动语音/ })
    await voice.scrollIntoViewIfNeeded()
    await voice.focus()
    await expect(voice).toBeFocused()
    // Keep auto-start off; toggling the sharing preference itself must persist.
    await share.setChecked(!initial)
    await page.reload()
    await expect(share).toBeChecked({ checked: !initial })
  })

  test(`Reka mode group keeps a selection and supports arrow navigation · ${theme}`, async ({ page }) => {
    await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
    await page.goto('/prompt-builder')
    const group = page.getByRole('group', { name: '切换绘图工作模式' })
    const basic = group.getByRole('button', { name: '场景模式' })
    const pro = group.getByRole('button', { name: '专家模式' })
    await basic.click()
    await expect(basic).toHaveAttribute('aria-pressed', 'true')
    await basic.click()
    await expect(basic).toHaveAttribute('aria-pressed', 'true')
    await basic.press('ArrowRight')
    await expect(pro).toBeFocused()
    await pro.press('Space')
    await expect(pro).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.pb')).toHaveAttribute('data-director-mode', 'pro')
    await pro.press('Home')
    await expect(basic).toBeFocused()
    await basic.press('Enter')
    await expect(page.locator('.pb')).toHaveAttribute('data-director-mode', 'basic')
  })
}
