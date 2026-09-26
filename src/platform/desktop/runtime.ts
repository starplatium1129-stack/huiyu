import { configureApiTransport, type FetchImplementation } from '../../api/client.ts'
import { setRuntimeOrigin, setRuntimeFetch, resolveRuntimeUrl } from '../runtimeUrl.ts'
import { readDesktopBootstrap } from './bootstrap.ts'
import type { DesktopBootstrap } from '../../../types/desktop-bootstrap.ts'

export type DesktopConnectionState = { connection: 'starting' | 'ready' | 'unavailable'; bootstrap: DesktopBootstrap | null }
let state: DesktopConnectionState = { connection: 'starting', bootstrap: null }
const listeners = new Set<(state: DesktopConnectionState) => void>()
let refreshPending: Promise<void> | null = null
let epochController = new AbortController()
let started = false
let stop = () => {}
export function getDesktopRuntime(): DesktopConnectionState { return state }
export function getDesktopWindowRole() { return state.bootstrap?.windowRole }
export function onDesktopRuntime(listener: (value: DesktopConnectionState) => void): () => void {
  listeners.add(listener); listener(state)
  return () => listeners.delete(listener)
}
function publish(next: DesktopConnectionState) { state = next; for (const listener of listeners) listener(state) }

export const desktopRuntimeFetch: FetchImplementation = async (input, init = {}) => {
  const bootstrap = state.bootstrap
  if (!bootstrap?.runtime || state.connection !== 'ready') throw new Error('本地运行时尚未连接')
  const rawUrl = input instanceof Request ? input.url : String(input)
  const url = resolveRuntimeUrl(rawUrl)
  if (!url) throw new Error('资源地址不属于已验证的运行时')
  const headers = new Headers(init.headers)
  const pathname = new URL(url).pathname
  const privateRequest = pathname.startsWith('/api/workspace/') || pathname === '/api/tasks/v1' || pathname.startsWith('/api/tasks/v1/')
  if (privateRequest) {
    const session = bootstrap.runtime.workspace
    if (!session || session.expiresAt <= Date.now()) { void refreshDesktopRuntime(); throw new Error('工作区会话已过期，请重新读取') }
    headers.set('x-aics-workspace-session', session.token)
  }
  const signal = AbortSignal.any([epochController.signal, ...(init.signal ? [init.signal] : [])])
  // Same-origin GET/HEAD omit Origin. The private session authority also needs
  // browser provenance; send only the origin while retaining the document's
  // no-referrer policy for unrelated requests and never emitting a private URL.
  const referrerPolicy = privateRequest && new URL(url).origin === window.location.origin ? 'origin' : init.referrerPolicy
  const response = await fetch(url, { ...init, headers, signal, referrerPolicy })
  if (response.status === 401) void refreshDesktopRuntime()
  return response
}

export function refreshDesktopRuntime(): Promise<void> {
  if (refreshPending) return refreshPending
  refreshPending = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const bootstrap = await Promise.race([readDesktopBootstrap(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('桌面握手超时')), 4000)
      })])
      const previous = state.bootstrap?.runtime
      const next = bootstrap.runtime
      const changed = previous?.runtimeEpoch !== next?.runtimeEpoch || previous?.origin !== next?.origin
        || previous?.workspace?.generation !== next?.workspace?.generation
      setRuntimeOrigin(next?.origin ?? null, true)
      if (changed) { epochController.abort(); epochController = new AbortController(); configureApiTransport(desktopRuntimeFetch) }
      publish({ connection: bootstrap.connection, bootstrap })
    } catch {
      setRuntimeOrigin(null, true)
      epochController.abort(); epochController = new AbortController()
      configureApiTransport(desktopRuntimeFetch)
      publish({ connection: 'unavailable', bootstrap: state.bootstrap })
    } finally { if (timer) clearTimeout(timer); refreshPending = null }
  })()
  return refreshPending
}

/** Mount callers can await this bounded first handshake; failure preserves the UI. */
export async function initializeDesktopRuntime(): Promise<() => void> {
  if (started) return stop
  started = true
  setRuntimeFetch(desktopRuntimeFetch)
  setRuntimeOrigin(null, true)
  configureApiTransport(desktopRuntimeFetch)
  await refreshDesktopRuntime()
  const timer = setInterval(() => { void refreshDesktopRuntime() }, 10_000)
  let unlisten: (() => void) | undefined
  const events = (window as unknown as { __TAURI__?: { event?: { listen(name: string, listener: () => void): Promise<() => void> } } }).__TAURI__?.event
  let disposed = false
  void events?.listen('aics:gateway-ready', () => { void refreshDesktopRuntime() }).then(remove => { if (disposed) remove(); else unlisten = remove })
  stop = () => { disposed = true; started = false; clearInterval(timer); unlisten?.(); epochController.abort(); listeners.clear() }
  return stop
}
