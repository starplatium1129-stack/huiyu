import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

for (const theme of ['dark', 'light']) {
  test(`appearance radio groups support keyboard selection and persist ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 720 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(theme => {
      if (localStorage.getItem('appearance-keyboard-fixture')) return
      localStorage.setItem('appearance-keyboard-fixture', 'ready')
      localStorage.setItem('aics_theme', theme)
      localStorage.setItem('atelier-desktop-appearance-v1', JSON.stringify({ theme, motion: 'reduce', reducedGlass: true, glass: 'light' }))
      localStorage.setItem('aics_guest_guide_dismissed', '1')
    }, theme)
    // Neutral shell: this preference test never loads real scenes or a model API.
    await page.route('**/*', route => {
      const url = new URL(route.request().url()), pathname = url.pathname
      if (pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true } })
      if (pathname.startsWith('/data/')) return route.fulfill({ json: [] })
      if (!pathname.startsWith('/assets/') || url.searchParams.has('import')) return route.continue()
      const asset = pathname.slice('/assets/'.length)
      if (!['theme-bootstrap.js', 'favicon.svg', 'logo.svg', 'logo-light.svg'].includes(asset) && !asset.startsWith('fonts/')) return route.abort()
      return route.fulfill({ path: resolve('assets', asset) })
    })
    await page.goto('/appearance-keyboard-fixture', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: '页面走丢了', exact: true })).toBeVisible()
    await page.keyboard.press('F1')
    const shortcuts = page.getByRole('dialog', { name: '键盘快捷键', exact: true })
    await expect(shortcuts).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(shortcuts).toBeHidden()
    await page.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('button', { name: '外观与动态效果', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '外观与动态效果', exact: true })
    await expect(dialog.getByRole('radiogroup', { name: '玻璃材质', exact: true })).toBeVisible()

    for (const name of ['画室主题', '动态效果', '玻璃材质']) {
      const group = dialog.getByRole('radiogroup', { name, exact: true })
      const radios = group.getByRole('radio')
      const original = await group.locator('[aria-checked="true"]').getAttribute('data-value')
      const values = await radios.evaluateAll(elements => elements.map(element => element.getAttribute('data-value')))
      const next = values[(values.indexOf(original) + 1) % values.length]
      await group.locator('[aria-checked="true"]').focus()
      await page.keyboard.press('ArrowRight')
      const selected = group.locator(`[data-value="${next}"]`)
      await expect(selected).toBeFocused()
      await expect(selected).toHaveAttribute('aria-checked', 'true')
      await expect(group.locator('[tabindex="0"]')).toHaveCount(1)
      await page.keyboard.press('ArrowLeft')
      await expect(group.locator(`[data-value="${original}"]`)).toHaveAttribute('aria-checked', 'true')
      await radios.last().click()
      await radios.last().press('ArrowDown')
      await expect(radios.first()).toBeFocused()
      await expect(radios.first()).toHaveAttribute('aria-checked', 'true')
      await page.keyboard.press('Tab')
      expect(await group.evaluate(element => element.contains(document.activeElement))).toBe(false)
    }
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('atelier-desktop-appearance-v1') || '{}'))
    expect(saved).toMatchObject({ theme: 'system', motion: 'system', glass: 'light', reducedGlass: true })
    // A keyboard request can reverse an in-flight pointer close without losing
    // the modal or the preference values that were just selected.
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await page.keyboard.press('F1')
    await expect(shortcuts).toBeVisible()
    expect(await shortcuts.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    await page.keyboard.press('Escape')
    await expect(shortcuts).toBeHidden()
    await expect(page.getByRole('button', { name: '更多', exact: true })).toBeFocused()
    await page.reload()
    await page.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('button', { name: '外观与动态效果', exact: true }).click()
    for (const [name, value] of [['画室主题', 'system'], ['动态效果', 'system'], ['玻璃材质', 'light']]) {
      await expect(dialog.getByRole('radiogroup', { name, exact: true }).locator(`[data-value="${value}"]`)).toHaveAttribute('aria-checked', 'true')
    }
    // A normal key during a pointer leave must finish native close and its lock.
    await dialog.getByRole('button', { name:'关闭', exact:true }).click()
    await page.keyboard.press('Tab')
    await expect(dialog).toBeHidden()
    expect(await page.evaluate(() => document.documentElement.style.overflow)).not.toBe('hidden')
  })
}
