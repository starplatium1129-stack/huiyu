import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark']) {
  test(`shared dialog motion keeps native focus and cancellation: ${theme}`, async ({ page }) => {
    await page.addInitScript(t => localStorage.setItem('aics_theme', t), theme)
    let writes = 0
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname
      if (!path.startsWith('/api/')) return route.continue()
      if (route.request().method() === 'POST') { writes++; return route.fulfill({ json: { ok: true } }) }
      if (path === '/api/status') return route.fulfill({ json: {
        ok: true, running: true, sdOnline: true, comfyOnline: true, ttsOnline: false,
        ollamaOnline: true, ollamaModels: [], ollamaVram: 0, webuiManaged: true, comfyManaged: true,
        modeBusy: false, operation: null, sdHost: 'http://127.0.0.1:7860', comfyHost: 'http://127.0.0.1:8188',
        ttsHost: 'http://127.0.0.1:9880', ollamaHost: '', localLink: 'http://127.0.0.1:3000/',
        shareLinkAvailable: false, tunnelStatus: 'disabled', tunnelAvailable: true, uptime: 60, voices: {},
        scripts: { webui: true, comfy: true, voiceStart: true, voiceStop: true },
      } })
      return route.fulfill({ json: { ok: true, jobs: [], tasks: [] } })
    })
    await page.goto('/scene-explorer')
    await page.locator('.task-center-button').click()
    const tasks = page.getByRole('dialog', { name: '任务中心' })
    await expect(tasks).toBeVisible()
    await page.waitForTimeout(650)
    await page.screenshot({ path: `scripts/archive/fluid-review/verified/${theme}-tasks.png` })
    await page.keyboard.press('Escape')
    await expect(tasks).toBeHidden()
    await expect(page.locator('.task-center-button')).toBeFocused()
    await page.goto('/control')
    const stop = page.locator('.service-row').filter({ hasText: 'SD WebUI' }).getByRole('button', { name: '停止', exact: true })
    await stop.click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm.getByRole('button', { name: '取消', exact: true })).toBeFocused()
    await page.waitForTimeout(650)
    await page.screenshot({ path: `scripts/archive/fluid-review/verified/${theme}-confirm.png` })
    await page.keyboard.press('Enter')
    await expect(confirm).toBeHidden()
    await expect(stop).toBeFocused()
    expect(writes).toBe(0)
  })

  test(`shared surfaces across workspaces: ${theme}`, async ({ page }) => {
    test.setTimeout(90000)
    await page.addInitScript(t => localStorage.setItem('aics_theme', t), theme)
    for (const path of ['/', '/showcase', '/popular-scenes', '/prompt-builder', '/gallery', '/video-studio', '/character']) {
      await page.goto(path)
      await page.locator('.nav').waitFor()
      await page.waitForTimeout(1600)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: `scripts/archive/fluid-review/verified/${theme}-${path.slice(1) || 'home'}.png` })
      if (path === '/prompt-builder') {
        const switcher = page.locator('.material-switch')
        if (await switcher.isVisible()) {
          const buttons = switcher.locator('button')
          await buttons.nth(1).click(); await buttons.nth(0).click()
          await page.waitForTimeout(650)
          const pill = await switcher.locator('.animated-selection').boundingBox()
          const active = await buttons.nth(0).boundingBox()
          expect(Math.abs(pill!.x - active!.x)).toBeLessThan(1)
          expect(Math.abs(pill!.width - active!.width)).toBeLessThan(1)
        }
      }
    }
  })

  test(`fluid search reverses without remounting and restores focus: ${theme}`, async ({ page }) => {
    await page.addInitScript(t => localStorage.setItem('aics_theme', t), theme)
    await page.goto('/scene-explorer')
    await page.locator('.nav-search').click()
    const panel = page.getByRole('dialog', { name: '全局搜索' })
    await expect(page.getByRole('searchbox', { name: '搜索场景、作品或页面' })).toBeFocused()
    await expect(panel).toBeVisible()
    await page.waitForTimeout(600)
    await panel.evaluate(el => el.setAttribute('data-continuity-probe', 'same-surface'))
    await page.keyboard.press('Escape')
    await expect(page.locator('.nav-search')).toBeFocused()
    await expect(page.locator('.global-search')).toHaveAttribute('inert', '')
    await page.waitForTimeout(45)
    const closing = await page.locator('.global-search').evaluate(el => Number(getComputedStyle(el).opacity))
    expect(closing).toBeGreaterThan(0); expect(closing).toBeLessThan(1)
    await page.keyboard.press('Control+k')
    await expect(panel).toHaveAttribute('data-continuity-probe', 'same-surface')
    await expect(page.locator('.gs-input')).toBeFocused()
    await page.waitForTimeout(650)
    await expect(page.locator('.global-search')).toHaveCSS('opacity', '1')
    await page.screenshot({ path: `scripts/archive/fluid-review/verified/${theme}-search.png` })
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Escape'); await page.waitForTimeout(35)
      await page.keyboard.press('Control+k'); await page.waitForTimeout(35)
    }
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    await expect(page.locator('body')).not.toHaveClass(/overlay-open/)
  })

  test(`reduced motion, narrow search and navigation: ${theme}`, async ({ page }) => {
    await page.addInitScript(t => localStorage.setItem('aics_theme', t), theme)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/scene-explorer')
    await page.getByRole('button', { name: '打开导航菜单' }).click()
    await page.locator('.nav-search').click()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.locator('.global-search')).toHaveCSS('opacity', '1')
    await expect(page.locator('.gs-panel')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `scripts/archive/fluid-review/verified/${theme}-mobile.png` })
    await page.keyboard.press('Escape')
    await expect(page.locator('.global-search')).toBeHidden()
  })
}
