import assert from 'node:assert/strict'
import path from 'node:path'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import type { Browser, BrowserContext, BrowserContextOptions, Page } from '@playwright/test'
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
  const provenance: Array<{ requestId: string; url: string; origin?: string; referer?: string; site?: string; destination?: string }> = []
  const contexts = new Set<BrowserContext>()
  const provenanceReads = new Set<Promise<void>>()
  const provenanceFailures: unknown[] = []
  const trackedPages = new WeakMap<Page, Promise<void>>()
  const trackPage = (page: Page): Promise<void> => {
    const existing = trackedPages.get(page)
    if (existing) return existing
    const tracking = (async () => {
      const cdp = await page.context().newCDPSession(page)
      const requests = new Map<string, string>()
      const extraHeaders = new Map<string, Record<string, string>>()
      const pending = new Map<string, () => void>()
      const correlate = (requestId: string) => {
        const url = requests.get(requestId), raw = extraHeaders.get(requestId)
        if (!url || !raw) return
        const headers = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.toLowerCase(), value]))
        provenance.push({ requestId, url, origin: headers.origin, referer: headers.referer,
          site: headers['sec-fetch-site'], destination: headers['sec-fetch-dest'] })
        requests.delete(requestId); extraHeaders.delete(requestId)
        pending.get(requestId)?.(); pending.delete(requestId)
      }
      // ExtraInfo can precede requestWillBeSent. Join both by ID: Playwright's
      // allHeaders omits these browser-generated fields while routing assets.
      cdp.on('Network.requestWillBeSent', event => {
        if (!event.request.url.startsWith(stack.origin + '/api/workspace/') || event.request.method !== 'GET') {
          extraHeaders.delete(event.requestId); return
        }
        requests.set(event.requestId, event.request.url)
        const read = new Promise<void>(resolve => pending.set(event.requestId, resolve))
        provenanceReads.add(read)
        void read.finally(() => provenanceReads.delete(read))
        correlate(event.requestId)
      })
      cdp.on('Network.requestWillBeSentExtraInfo', event => {
        extraHeaders.set(event.requestId, event.headers)
        correlate(event.requestId)
      })
      cdp.on('Network.loadingFailed', event => {
        if (pending.has(event.requestId)) {
          provenanceFailures.push(`No request ExtraInfo: ${requests.get(event.requestId)} (${event.errorText})`)
          pending.get(event.requestId)?.(); pending.delete(event.requestId)
          requests.delete(event.requestId); extraHeaders.delete(event.requestId)
        }
      })
      page.once('close', () => {
        cdp.removeAllListeners()
        for (const resolve of pending.values()) resolve()
        pending.clear(); requests.clear(); extraHeaders.clear()
        void cdp.detach().catch(() => {})
      })
      await cdp.send('Network.enable')
    })()
    trackedPages.set(page, tracking)
    return tracking
  }
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
    contexts.add(context)
    context.once('close', () => contexts.delete(context))
    await context.addInitScript(descriptor => Object.assign(window, { __TAURI__: {
      core: { invoke: async () => descriptor }, event: { listen: async () => () => {} },
    } }), bootstrap)
    // Only the document and Vite assets are substituted; private API traffic
    // retains the real transport and the browser's wire provenance.
    await context.route(url => url.origin === stack.origin && (url.pathname === '/fixture'
      || /^\/(?:src|node_modules|@vite|@fs|@id)\//.test(url.pathname)), async route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/fixture') {
        await route.fulfill({ contentType: 'text/html', headers: { 'Referrer-Policy': 'no-referrer' }, body: html })
      } else if (/^\/(?:src|node_modules|@vite|@fs|@id)\//.test(url.pathname)) {
        const response = await route.fetch({ url: assets + url.pathname + url.search })
        await route.fulfill({ response })
      }
    })
    return context
  }
  return { ...stack, bootstrap, request, context, trackPage, provenance,
    flushProvenance: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([Promise.all(provenanceReads), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Browser request ExtraInfo did not arrive')), 5000)
        })])
        assert.deepEqual(provenanceFailures, [])
      } finally { if (timer) clearTimeout(timer) }
    },
    close: async () => {
      try {
        for (const context of contexts) {
          await context.unrouteAll({ behavior: 'wait' })
          await context.close()
        }
      } finally { try { await server.close() } finally { await stack.shutdown() } }
    } }
}
