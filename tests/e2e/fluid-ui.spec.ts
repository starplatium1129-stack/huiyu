import { expect, test } from '@playwright/test'

for (const theme of ['dark']) {
  test(`shared dialog motion keeps native focus and cancellation: ${theme}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
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
    await expect(tasks).toHaveCSS('opacity', '1')
    await page.screenshot({ path: `scripts/archive/fluid-review/verified/${theme}-tasks.png` })
    const fades = await tasks.evaluate(el => new Promise<{ surface: number[]; backdrop: number[] }>(resolve => {
      const surface: number[] = [], backdrop: number[] = []
      const sample = () => {
        if (!(el as HTMLDialogElement).open) { resolve({ surface, backdrop }); return }
        surface.push(Number(getComputedStyle(el).opacity))
        backdrop.push(Number(getComputedStyle(el, '::backdrop').opacity))
        requestAnimationFrame(sample)
      }
      ;(el.querySelector('[aria-label="关闭任务中心"]') as HTMLButtonElement).click()
      requestAnimationFrame(sample)
    }))
    expect(fades.surface.some(value => value > .15 && value < .85)).toBe(true)
    expect(fades.backdrop.some(value => value > .15 && value < .85)).toBe(true)
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

  test(`material selection settles on the active button: ${theme}`, async ({ page }) => {
    await page.addInitScript(t => localStorage.setItem('aics_theme', t), theme)
    await page.goto('/prompt-builder')
    const switcher = page.locator('.material-switch')
    await expect(switcher).toBeVisible()
    const buttons = switcher.locator('button')
    await buttons.nth(1).click()
    await buttons.nth(0).click()
    await expect.poll(async () => {
      const pill = await switcher.locator('.animated-selection').boundingBox()
      const active = await buttons.nth(0).boundingBox()
      return Math.max(Math.abs(pill!.x - active!.x), Math.abs(pill!.width - active!.width))
    }).toBeLessThan(1)
  })

  test(`fluid search reverses without remounting and restores focus: ${theme}`, async ({ page }) => {
    await page.addInitScript(t => localStorage.setItem('aics_theme', t), theme)
    await page.goto('/scene-explorer')
    await page.locator('.nav-search').click()
    const panel = page.getByRole('dialog', { name: '全局搜索' })
    await expect(page.getByRole('combobox', { name: '搜索场景、作品或页面' })).toBeFocused()
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

  test(`reduced motion and desktop search: ${theme}`, async ({ page }) => {
    await page.addInitScript(t => localStorage.setItem('aics_theme', t), theme)
    await page.setViewportSize({ width: 1024, height: 844 })
    await page.goto('/scene-explorer')
    await page.locator('.nav-search').click()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.locator('.global-search')).toHaveCSS('opacity', '1')
    await expect.poll(() => page.locator('.gs-panel').evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).isIdentity)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `scripts/archive/fluid-review/verified/${theme}-desktop-search.png` })
    await page.keyboard.press('Escape')
    await expect(page.locator('.global-search')).toBeHidden()
  })
}

for (const theme of ['dark']) {
  test(`welcome guide fades its content and backdrop on exit ${theme}`, async ({ page }) => {
    await page.addInitScript(theme => localStorage.setItem('aics_theme', theme), theme)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.goto('/showcase')
    await expect(page.locator('.showcase-page')).toBeVisible()
    await page.evaluate(() => window.dispatchEvent(new Event('atelier:welcome')))
    const guide = page.getByRole('dialog', { name: '访客导览', exact: true })
    await expect(guide).toHaveCSS('opacity', '1')
    const opacity = await guide.evaluate(el => new Promise<number[]>(resolve => {
      const frames: number[] = []
      const sample = () => {
        if (!el.isConnected) { resolve(frames); return }
        frames.push(Number(getComputedStyle(el).opacity))
        requestAnimationFrame(sample)
      }
      ;(el.querySelector('.guest-guide-actions button') as HTMLButtonElement).click()
      requestAnimationFrame(sample)
    }))
    expect(opacity.some(value => value > .15 && value < .85)).toBe(true)
    await expect(guide).toHaveCount(0)
  })
}
