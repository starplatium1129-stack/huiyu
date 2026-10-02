import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chromium } from '@playwright/test'
import { startRustBrowserFixture } from './rust-browser-fixture.mjs'
const fixture = await startRustBrowserFixture()
const { origin, bootstrap, provenance } = fixture
const executablePath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(file => fs.existsSync(file))
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
try {
  const context = await fixture.context(browser)
  await context.addInitScript(descriptor => {
    Object.assign(window, { fixtureOffline: false, __TAURI__: { core: { invoke: async () => {
      if (Reflect.get(window, 'fixtureOffline')) throw new Error('fixture disconnected')
      return descriptor
    } }, event: { listen: async () => () => {} } } })
  }, bootstrap)
  const page = await context.newPage()
  await page.goto(origin + '/fixture')
  const original = await page.evaluate(async () => {
    const { kvSet } = await import(String('/src/composables/useKVStore.ts'))
    await kvSet('aics_pb_history', [{ id: 'old-profile-record', image_id: 'old-original' }])
    localStorage.setItem('aics_theme', 'light')
    const { initializePlatform } = await import(String('/src/platform/initializePlatform.ts'))
    await initializePlatform(() => false)
    const { artworkRepository: repo } = await import(String('/src/storage/artworkRepository.ts'))
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII='), char => char.charCodeAt(0))
    const imageId = await repo.putImage(new Blob([png], { type: 'image/png' }))
    await repo.appendArtwork({ id: 'saved-browser', image_id: imageId, prompt: 'original prompt', favorite: false })
    await repo.patchArtwork('saved-browser', { favorite: true })
    const { settingsRepository, THEME_SETTING } = await import(String('/src/storage/settingsRepository.ts'))
    settingsRepository.set(THEME_SETTING, 'dark')
    const { flushProfileWrites } = await import(String('/src/platform/web/profileStorage.ts'))
    await flushProfileWrites()
    return { history: await repo.readHistory(), bytes: (await repo.getImage(imageId)).size, rawTheme: globalThis.localStorage.getItem('aics_theme') }
  })
  assert.equal(original.history.length, 1)
  assert.equal(original.history[0].favorite, true)
  assert.ok(original.bytes > 0)
  assert.equal(original.rawTheme, 'light', 'runtime setting never double-writes the old source')
  const provenanceResult = await page.evaluate(async () => {
    const descriptor = await Reflect.get(window, '__TAURI__').core.invoke('desktop_bootstrap')
    const raw = await fetch('/api/workspace/status', { headers: { 'x-aics-workspace-session': descriptor.runtime.workspace.token } })
    const { desktopRuntimeFetch } = await import(String('/src/platform/desktop/runtime.ts'))
    const transported = await desktopRuntimeFetch('/api/workspace/status')
    return { rawStatus: raw.status, transportedStatus: transported.status }
  })
  assert.equal(provenanceResult.rawStatus, 401, 'a token alone with omitted browser provenance remains denied')
  assert.equal(provenanceResult.transportedStatus, 200, 'private same-origin GET works under the production no-referrer document policy')
  assert.ok(provenance.some(request => request.origin === undefined && request.referer === origin + '/' && request.site === 'same-origin'),
    'the browser sends origin-only Referer, not the current private document path')
  const mediaResponse = page.waitForResponse(response => response.url().includes('/api/workspace/media-content/') && response.request().resourceType() === 'media')
  await page.evaluate(async alias => {
    const { desktopRuntimeFetch } = await import(String('/src/platform/desktop/runtime.ts'))
    const minted = await desktopRuntimeFetch('/api/workspace/media-capabilities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias }) })
    const capability = await minted.json()
    const video = document.createElement('video')
    video.id = 'private-media-fixture'; video.crossOrigin = 'anonymous'; video.preload = 'metadata'; video.src = capability.url
    document.body.append(video)
  }, original.history[0].image_id)
  const domMedia = await mediaResponse
  console.log('Same-origin DOM media provenance:', JSON.stringify({ status: domMedia.status(), ...provenance.find(request => request.destination === 'video') }))
  assert.ok([200, 206].includes(domMedia.status()), 'DOM media capabilities work under the production no-referrer policy')
  await page.evaluate(() => { const video = document.querySelector<HTMLVideoElement>('#private-media-fixture'); video?.pause(); video?.removeAttribute('src'); video?.load(); video?.remove() })
  await page.reload()
  const resumed = await page.evaluate(async () => {
    const { initializePlatform } = await import(String('/src/platform/initializePlatform.ts'))
    await initializePlatform(() => false)
    const { artworkRepository: repo } = await import(String('/src/storage/artworkRepository.ts'))
    const { settingsRepository, THEME_SETTING } = await import(String('/src/storage/settingsRepository.ts'))
    const history = await repo.readHistory()
    Object.assign(window, { fixtureOffline: true })
    const { refreshDesktopRuntime } = await import(String('/src/platform/desktop/runtime.ts'))
    await refreshDesktopRuntime()
    const cached = await repo.readHistory()
    let denied = false
    try { await repo.appendArtwork({ id: 'offline-write', image_id: history[0].image_id }) } catch { denied = true }
    Object.assign(window, { fixtureOffline: false })
    await refreshDesktopRuntime()
    const { kvGet, kvSet } = await import(String('/src/composables/useKVStore.ts'))
    let oldWriteDenied = false
    try { await kvSet('aics_pb_history', []) } catch { oldWriteDenied = true }
    return { history, cached, denied, theme: settingsRepository.get(THEME_SETTING), oldHistory: await kvGet('aics_pb_history'), oldWriteDenied, href: location.href }
  })
  assert.deepEqual(resumed.cached, resumed.history)
  assert.equal(resumed.denied, true)
  assert.equal(resumed.theme, 'dark')
  assert.equal(resumed.oldHistory[0].id, 'old-profile-record')
  assert.equal(resumed.oldWriteDenied, true)
  assert.equal(resumed.href, origin + '/fixture')
  await context.close()
  console.log('Desktop library browser: actual frontend adapters → private HTTP → SQLite/media, original bytes, settings without dual-write, reload, disconnect cached reads, denied writes and reconnect without navigation passed. Isolated browser, not native WebView2.')
} finally { await browser.close(); await fixture.close() }
