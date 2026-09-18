import { test, expect, type Page, type Locator } from '@playwright/test'
import { readFileSync } from 'node:fs'
import MOCK_PORTS from '../../scripts/lib/e2e-ports.js'
import { textContrast } from './helpers/contrast'

async function waitForSettledSurface(locator: Locator) {
  await expect.poll(() => locator.evaluate(element => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (Number(getComputedStyle(node).opacity) !== 1) return false
    }
    return true
  })).toBe(true)
}

async function settledContrast(locator: Locator) {
  await waitForSettledSurface(locator)
  return locator.evaluate(textContrast)
}

async function navigateThroughRouter(page: Page, path: string) {
  await page.evaluate(destination => {
    const app = document.querySelector('#app') as unknown as { __vue_app__: { config: { globalProperties: { $router: { push: (path: string) => Promise<unknown> } } } } }
    void app.__vue_app__.config.globalProperties.$router.push(destination)
  }, path)
  await expect(page).toHaveURL(new RegExp(path.split('?')[0].replace(/\/$/, '') + '/?(?:\\?|$)'))
  await expect(page.locator('#app')).not.toBeEmpty()
}

// Native media coverage needs the complete Chromium browser, not headless shell.
// channel is a worker option and must be declared at file scope.
test.use({ channel: 'chromium' })

test.describe('document microphone permissions', () => {
  test('microphone policy follows real documents and grants only voice pages', async ({ page, context }) => {
    await context.grantPermissions(['microphone'])
    await page.addInitScript(() => Object.defineProperty(window, '__voiceDocument', { value: crypto.randomUUID() }))
    const identity = () => page.evaluate(() => (window as unknown as { __voiceDocument: string }).__voiceDocument)
    const microphoneAllowed = () => page.evaluate(() => {
      type Policy = { allowsFeature: (feature: string) => boolean }
      const current = document as Document & { permissionsPolicy?: Policy; featurePolicy?: Policy }
      const policy = current.permissionsPolicy ?? current.featurePolicy
      if (!policy) throw new Error('Chromium document permissions policy API is required for this regression')
      return policy.allowsFeature('microphone')
    })
    const acquire = () => page.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const tracks = stream.getTracks()
        const audioTracks = stream.getAudioTracks().length
        tracks.forEach(track => track.stop())
        return { acquired: true, audioTracks, stopped: tracks.every(track => track.readyState === 'ended'), error: '' }
      } catch (error) { return { acquired: false, stopped: true, error: (error as DOMException).name, message: (error as DOMException).message } }
    })
    const response = await page.goto('/gallery')
    expect(response!.headers()['permissions-policy']).toContain('microphone=()')
    // Keep both the actual policy and getUserMedia denial as independent assertions.
    expect(await microphoneAllowed()).toBe(false)
    expect(await acquire()).toMatchObject({ acquired: false, error: 'NotAllowedError' })
    const galleryDocument = await identity()
    await navigateThroughRouter(page, '/companion-chat')
    await expect.poll(identity).not.toBe(galleryDocument)
    expect(await microphoneAllowed()).toBe(true)
    expect(await acquire()).toMatchObject({ acquired: true, audioTracks: 1, stopped: true })
    const voiceDocument = await identity()
    await navigateThroughRouter(page, '/gallery')
    await expect.poll(identity).not.toBe(voiceDocument)
    expect(await microphoneAllowed()).toBe(false)
    expect((await acquire()).acquired).toBe(false)
    for (const path of ['/chat/', '/companion', '/companion-chat?voice=test']) {
      const documentResponse = await page.goto(path)
      expect(documentResponse!.headers()['permissions-policy']).toContain('microphone=(self)')
      expect(documentResponse!.headers()['permissions-policy']).toContain('camera=()')
      if (path.startsWith('/companion-chat')) expect(documentResponse!.headers()['content-security-policy']).not.toContain("'unsafe-eval'")
      expect(await microphoneAllowed()).toBe(true)
      expect(await acquire()).toMatchObject({ acquired: true, audioTracks: 1, stopped: true })
    }
  })
})

for (const storageBlocked of [false, true]) {
  test(`document policy follows real browser navigation, storage blocked=${storageBlocked}`, async ({ page }) => {
    await page.addInitScript(blocked => {
      Object.defineProperty(window, '__officeDocumentId', { value: crypto.randomUUID() })
      if (blocked) Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('storage disabled', 'SecurityError') } })
    }, storageBlocked)
    const documentId = () => page.evaluate(() => (window as unknown as { __officeDocumentId: string }).__officeDocumentId)
    const documents: Array<{ path: string; csp: string }> = []
    page.on('response', response => {
      if (response.request().resourceType() === 'document') documents.push({ path: new URL(response.url()).pathname, csp: response.headers()['content-security-policy'] || '' })
    })
    await page.goto('/gallery')
    await expect(page.locator('a[href="/chat"]').first()).toBeAttached()
    const galleryDocument = await documentId()
    await navigateThroughRouter(page, '/chat/?src=office')
    await expect.poll(documentId).not.toBe(galleryDocument)
    const chatDocument = await documentId()
    await navigateThroughRouter(page, '/companion?src=office')
    expect(await documentId()).toBe(chatDocument)
    await navigateThroughRouter(page, '/gallery')
    await expect.poll(documentId).not.toBe(chatDocument)
    await page.goBack()
    await expect(page).toHaveURL(/\/companion\?src=office/)
    await page.goForward()
    await expect(page).toHaveURL(/\/gallery$/)
    for (const item of documents) {
      const live = ['/chat', '/companion'].includes(item.path.replace(/\/+$/, ''))
      expect(item.csp.includes("'unsafe-eval'"), item.path).toBe(live)
      expect(item.csp.split(';').find(directive => directive.trim().startsWith('script-src '))).not.toContain("'unsafe-inline'")
    }
    for (const target of ['/chat/', '/companion?src=direct', '/gallery']) {
      const response = await page.goto(target)
      expect(response!.headers()['content-security-policy'].includes("'unsafe-eval'")).toBe(target !== '/gallery')
      await expect(page.locator('#app')).not.toBeEmpty()
    }
  })
}

for (const theme of ['dark', 'light']) {
  test(`first artwork keyboard journey and deferred panels ${theme}`, async ({ page, request }) => {
    const gateway = `http://127.0.0.1:${MOCK_PORTS.gateway}`
    const comfy = `http://127.0.0.1:${MOCK_PORTS.translate + 1}`
    await request.post(`${comfy}/__mock/reset`)
    await request.post(`${comfy}/__mock/fault`, { data: { renderMs: 10 } })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    const scripts: string[] = []
    page.on('request', req => { if (req.resourceType() === 'script') scripts.push(new URL(req.url()).pathname) })
    await page.goto(`${gateway}/prompt-builder`)
    await expect(page.locator('.material-switch')).toBeVisible()
    // Preserve the real gateway/result request, but replace its 1px mock image with
    // a clearly labelled portrait fixture so visual checks exercise actual image layout.
    const fixture = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 832; canvas.height = 1216
      const context = canvas.getContext('2d')!
      for (let y = 0; y < canvas.height; y += 64) for (let x = 0; x < canvas.width; x += 64) {
        context.fillStyle = (x / 64 + y / 64) % 2 ? '#d5d5d5' : '#eeeeee'
        context.fillRect(x, y, 64, 64)
      }
      context.fillStyle = '#202020'; context.font = 'bold 36px sans-serif'
      context.fillText('UI TEST IMAGE', 64, 128)
      context.font = '28px sans-serif'; context.fillText('832 x 1216 / no model rendering', 64, 184)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    await page.route(/\/api\/anima\/jobs\/[^/]+\/result$/, async route => {
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      expect(response.headers()['content-type']).toMatch(/^image\//)
      await route.fulfill({ response, contentType: 'image/png', body: Buffer.from(fixture, 'base64') })
    })
    await page.locator('[aria-controls="material-character"]').focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('#material-character')).toBeVisible()
    const character = page.locator('.char-btn').filter({ hasText: '宁宁' }).first()
    await character.focus(); await page.keyboard.press('Enter')
    await expect(character).toHaveAttribute('aria-pressed', 'true')
    await page.locator('[aria-controls="material-scenes"]').focus()
    await page.keyboard.press('Enter')
    const scene = page.locator('button.scene-card').filter({ hasText: '樱花树下的约定' }).first()
    await scene.focus(); await page.keyboard.press('Enter')
    const generate = page.getByTestId('anima-generate')
    await expect(generate).toBeEnabled()
    expect(scripts.some(url => /AnimaInpaintModal-|BatchSceneDrawPanel-|PromptComparePanel-/.test(url))).toBe(false)
    await generate.focus(); await page.keyboard.press('Enter')
    await expect(page.locator('.result-image')).toBeVisible({ timeout: 15000 })
    const save = page.getByRole('button', { name: '存入作品册', exact: true })
    await expect(save).toBeEnabled()
    const archiveContrast = await settledContrast(save)
    expect(archiveContrast).toBeGreaterThanOrEqual(4.5)
    await save.focus(); await page.keyboard.press('Enter')
    await expect(page.locator('.stage-archive-badge')).toHaveText('已入册')
    await expect(page.getByRole('button', { name: '存入作品册', exact: true })).toHaveCount(0)
    await page.getByRole('link', { name: '查看作品册', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.artwork')).toHaveCount(1)
    const artwork = page.locator('.artwork').first()
    await artwork.locator('.artwork-button').focus()
    await waitForSettledSurface(artwork)
    await expect.poll(() => artwork.locator('img').evaluateAll(images => images.some(image => {
      const img = image as HTMLImageElement
      return img.complete && img.naturalWidth > 0 && Number(getComputedStyle(img).opacity) === 1
    }))).toBe(true)
    await page.screenshot({ path: `.review-shots/office-code-gallery-${theme}.png`, fullPage: true })
    await page.goBack()
    await expect(generate).toBeEnabled()
    const oldImage = await page.locator('.result-image').getAttribute('src')
    await generate.click()
    await expect(page.locator('.result-image')).not.toHaveAttribute('src', oldImage!)
    const compare = page.getByRole('button', { name: '与上一张对比', exact: true })
    await expect(compare).toBeEnabled()
    await compare.click()
    const dialog = page.getByRole('dialog', { name: '出图对比' })
    await expect(dialog).toBeVisible()
    // Visibility alone includes the first transparent transition frame. Measure the settled surface.
    await expect(page.locator('.pb-compare-overlay')).not.toHaveClass(/layer-pop-enter/)
    await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeFocused()
    await expect.poll(() => dialog.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true)
    const compareContrast = await settledContrast(dialog.locator('.pb-compare-kicker'))
    expect(compareContrast).toBeGreaterThanOrEqual(4.5)
    console.log(JSON.stringify({ theme, archiveContrast, compareContrast }))
    await page.screenshot({ path: `.review-shots/office-code-compare-${theme}.png`, fullPage: true })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(compare).toBeFocused()
    await page.screenshot({ path: `.review-shots/office-code-result-${theme}.png`, fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  })

  test(`diagnostic download contains only approved metadata ${theme}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(value => localStorage.setItem('aics_theme', value), theme)
    await page.route('**/api/diagnostics', route => route.fulfill({ json: {
      timestamp: new Date().toISOString(), uptime: 3, port: 3000, nodeVersion: 'v24.18.0', platform: 'win32',
      runtimeConfig: { apiKey: 'private-key', messages: ['private-chat'] }, sdHost: 'private-host',
      token: { present: true, suffix: 'private-token' }, scripts: { voiceStart: 'private-path', voiceStartExists: true },
      imageDataUrl: 'private-pixels', operation: null,
    } }))
    await page.goto('/control')
    const downloading = page.waitForEvent('download')
    const button = page.getByRole('button', { name: '导出诊断包', exact: true })
    await expect(button).toBeEnabled()
    const diagnosticContrast = await settledContrast(button)
    expect(diagnosticContrast).toBeGreaterThanOrEqual(4.5)
    console.log(JSON.stringify({ theme, diagnosticContrast }))
    await button.click()
    const download = await downloading
    expect(download.suggestedFilename()).toMatch(/^huiyu-diagnostics-.*\.json$/)
    const content = readFileSync((await download.path())!, 'utf8')
    expect(content).not.toContain('private-')
    expect(JSON.parse(content)).toMatchObject({ type: 'huiyu-diagnostics', schemaVersion: 2, dataVersion: expect.any(Number), diagnostics: { scope: 'current-page-session' } })
    await expect(button).toBeEnabled()
    await page.screenshot({ path: `.review-shots/office-code-diagnostics-${theme}.png`, fullPage: true })
  })
}
