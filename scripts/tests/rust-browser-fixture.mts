import assert from 'node:assert/strict'
import path from 'node:path'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import type { Browser, BrowserContextOptions } from '@playwright/test'
import stackFactory from './mock-stack.js'

/** Vite transforms the existing frontend; every /api request reaches the Rust
 * process. Routing source assets in the browser retains the runtime's real
 * origin/provenance checks without a replacement Node workspace implementation. */
export async function startRustBrowserFixture() {
  const stack = await stackFactory.start({ dynamicPorts: true, workspace: true, lightweight: true })
  const server = await createServer({ configFile: false, appType: 'custom', plugins: [vue()],
    resolve: { alias: { '@': path.resolve('src') } }, optimizeDeps: { noDiscovery: true, entries: [] },
    server: { host: '127.0.0.1', port: 0, watch: null } })
  try { await server.listen() } catch (error) { await stack.shutdown(); throw error }
  const address = server.httpServer!.address()
  assert.ok(address && typeof address === 'object')
  const assets = `http://127.0.0.1:${address.port}`
  const provenance: Array<{ origin?: string; referer?: string; site?: string; destination?: string }> = []
  const session = (await stack.session()).workspace
  const bootstrap = { protocolVersion: 1, windowRole: 'atelier', windowId: 'atelier', bundledUiAvailable: false,
    sourceProfileId: stack.sourceProfileId, sourceOrigin: stack.origin, connection: 'ready',
    runtime: { origin: stack.origin, protocolVersion: 1, ownership: 'managed', runtimeEpoch: session.runtimeEpoch,
      workspace: { ...session, domains: ['artwork', 'settings', 'chat', 'draft'], generation: 1, bundledUi: false } } }
  const request = async (endpoint: string, method = 'GET', input?: unknown) => {
    const response = await fetch(stack.origin + endpoint, { method, signal: AbortSignal.timeout(30_000),
      headers: { origin: stack.origin, 'x-aics-workspace-session': session.token, 'content-type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
    const value = await response.json()
    assert.equal(response.status, 200, JSON.stringify(value))
    return value.result
  }
  const context = async (browser: Browser, html = '<!doctype html><title>Isolated Rust browser fixture</title>', options: BrowserContextOptions = {}) => {
    const context = await browser.newContext(options)
    await context.addInitScript(descriptor => Object.assign(window, { __TAURI__: {
      core: { invoke: async () => descriptor }, event: { listen: async () => () => {} },
    } }), bootstrap)
    await context.route(stack.origin + '/**', async route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/fixture') {
        await route.fulfill({ contentType: 'text/html', headers: { 'Referrer-Policy': 'no-referrer' }, body: html })
      } else if (/^\/(?:src|node_modules|@vite|@fs|@id)\//.test(url.pathname)) {
        const response = await route.fetch({ url: assets + url.pathname + url.search })
        await route.fulfill({ response })
      } else {
        if (url.pathname.startsWith('/api/workspace/') && route.request().method() === 'GET') {
          const headers = await route.request().allHeaders()
          provenance.push({ origin: headers.origin, referer: headers.referer, site: headers['sec-fetch-site'], destination: headers['sec-fetch-dest'] })
        }
        await route.continue()
      }
    })
    return context
  }
  return { ...stack, bootstrap, request, context, provenance,
    close: async () => { try { await server.close() } finally { await stack.shutdown() } } }
}
