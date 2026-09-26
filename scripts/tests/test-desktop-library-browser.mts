import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'
import { createServer } from 'vite'
import { chromium } from '@playwright/test'
const require = createRequire(import.meta.url)
const { openWorkspace } = require('../../server/workspace/client.js')
const { createWorkspaceGateway } = require('../../server/workspace/gateway.js')
const { createWorkspaceMediaRouter } = require('../../server/workspace/host-media.js')
const { removeFixtureRoot } = require('./gateway-test-stack.js')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-library-browser-'))
const service = await openWorkspace({ root, workspaceId: 'browser-library', create: true })
const reserved = net.createServer()
await new Promise<void>(resolve => reserved.listen(0, '127.0.0.1', resolve))
const port = (reserved.address() as net.AddressInfo).port
await new Promise<void>(resolve => reserved.close(() => resolve()))
const server = await createServer({ configFile: false, appType: 'custom', resolve: { alias: { '@': path.resolve('src') } },
  optimizeDeps: { noDiscovery: true, entries: [] }, server: { host: '127.0.0.1', port, strictPort: true, watch: null } })
server.middlewares.use((req, res, next) => { if (req.url !== '/fixture') return next(); res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Isolated desktop library</title>') })
await server.listen()
const address = server.httpServer!.address()
if (!address || typeof address === 'string') throw new Error('No browser fixture port')
const origin = `http://127.0.0.1:${address.port}`
const binding = createWorkspaceGateway({ service, allowedOrigins: [origin] })
const app = require('express')()
app.use('/api/workspace', createWorkspaceMediaRouter(service, binding.authority))
app.use('/api/workspace', binding.router)
server.middlewares.use(app)
const session = binding.authority.issue({ origin, principalId: 'browser-fixture', scopes: ['workspace:read', 'workspace:write', 'workspace:backup'] })
const bootstrap = { protocolVersion: 1, windowRole: 'atelier', windowId: 'atelier', bundledUiAvailable: false, sourceProfileId: `profile-${'a'.repeat(64)}`,
  sourceOrigin: origin, connection: 'ready', runtime: { origin, protocolVersion: 1, ownership: 'managed', runtimeEpoch: service.runtimeEpoch,
    workspace: { ...session, domains: ['artwork', 'settings', 'chat', 'draft'], generation: 1, bundledUi: false } } }
const executablePath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(file => fs.existsSync(file))
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
try {
  const context = await browser.newContext()
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
} finally { await browser.close(); await server.close(); await binding.close(); removeFixtureRoot(root) }
