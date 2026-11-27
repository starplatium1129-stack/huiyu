import { configureApiTransport, type FetchImplementation } from '../../api/client.ts'
import { setRuntimeOrigin, setRuntimeFetch, resolveRuntimeUrl } from '../runtimeUrl.ts'
import { readDesktopBootstrap } from './bootstrap.ts'
import type { DesktopBootstrap } from '../../../types/desktop-bootstrap.ts'
import { hostApi } from './hostApi.ts'
import { observeWindowVisibility } from '../windowVisibility'

export type DesktopConnectionState = { connection: 'starting' | 'ready' | 'unavailable'; bootstrap: DesktopBootstrap | null }
let state: DesktopConnectionState = { connection: 'starting', bootstrap: null }
const listeners = new Set<(state: DesktopConnectionState) => void>()
let refreshPending: Promise<void> | null = null
let refreshSequence = 0
let epochController = new AbortController()
let runtimeSetup: { stop: () => void; ready: Promise<void> } | undefined
export function getDesktopRuntime(): DesktopConnectionState { return state }
export function desktopRuntimeIdentity(bootstrap = state.bootstrap): string {
  const runtime = bootstrap?.runtime, workspace = runtime?.workspace
  return JSON.stringify([bootstrap?.sourceProfileId, runtime?.origin, runtime?.runtimeEpoch,
    workspace?.workspaceId, workspace?.principalId, workspace?.runtimeEpoch, workspace?.generation])
}
export function getDesktopWindowRole() {
  const label = state.bootstrap?.windowRole ?? hostApi()?.window.getCurrentWindow().label
  if (label === 'atelier' || label === 'companion' || label === 'companion-chat') return label
}
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
  const { pathname, origin } = new URL(url)
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
  const referrerPolicy = privateRequest && origin === window.location.origin ? 'origin' : init.referrerPolicy
  let response: Response
  try { response = await fetch(url, { ...init, headers, signal, referrerPolicy }) }
  catch (error) {
    if (!signal.aborted) void refreshDesktopRuntime()
    throw error
  }
  if (response.status === 401) void refreshDesktopRuntime()
  return response
}

export function refreshDesktopRuntime(force = false): Promise<void> {
  if (refreshPending && !force) return refreshPending
  const sequence = ++refreshSequence
  refreshPending = (async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const bootstrap = await Promise.race([readDesktopBootstrap(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('桌面握手超时')), 4000)
      })])
      if (sequence !== refreshSequence) return refreshPending ?? undefined
      const next = { connection: bootstrap.connection, bootstrap }
      const changed = state.connection !== next.connection || desktopRuntimeIdentity() !== desktopRuntimeIdentity(bootstrap)
      setRuntimeOrigin(bootstrap.runtime?.origin ?? null, true, bootstrap.runtime?.runtimeEpoch)
      if (changed) { epochController.abort(); epochController = new AbortController(); configureApiTransport(desktopRuntimeFetch) }
      publish(next)
    } catch {
      if (sequence !== refreshSequence) return refreshPending ?? undefined
      setRuntimeOrigin(null, true)
      epochController.abort(); epochController = new AbortController()
      configureApiTransport(desktopRuntimeFetch)
      publish({ connection: 'unavailable', bootstrap: state.bootstrap })
    } finally { if (timer) clearTimeout(timer); if (sequence === refreshSequence) refreshPending = null }
  })()
  return refreshPending
}

/** Establish the fail-closed transport before the first request can start. */
export function initializeDesktopRuntime() {
  if (runtimeSetup) return runtimeSetup
  epochController = new AbortController()
  setRuntimeFetch(desktopRuntimeFetch)
  setRuntimeOrigin(null, true)
  configureApiTransport(desktopRuntimeFetch)
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let visible = !document.hidden
  function scheduleRenewal() {
    clearTimeout(timer)
    if (disposed || !visible) return
    const session = state.bootstrap?.runtime?.workspace
    if (state.connection === 'ready' && !session) return
    const delay = state.connection === 'ready' && session ? session.expiresAt - Date.now() - 30_000 : 10_000
    // A visible disconnected window gets a fallback retry. A connected one
    // sleeps until renewal instead of waking every ten seconds.
    timer = setTimeout(() => { void refreshDesktopRuntime() }, Math.max(10_000, delay))
  }
  const stopRenewal = onDesktopRuntime(scheduleRenewal)
  const stopVisibility = observeWindowVisibility(value => {
    const resumed = !visible && value
    visible = value
    scheduleRenewal()
    const expiresAt = state.bootstrap?.runtime?.workspace?.expiresAt
    if (resumed && (state.connection !== 'ready' || expiresAt !== undefined && expiresAt <= Date.now() + 30_000)) {
      void refreshDesktopRuntime()
    }
  })
  const unlisten: (() => void)[] = []
  const events = hostApi()?.event
  // Subscribe before taking the first snapshot. A later ready event supersedes
  // a stale in-flight snapshot instead of waiting for the periodic renewal.
  const ready = (async () => {
    try {
      if (events) {
        const add = async (name: string, listener: () => void) => {
          const remove = await events.listen(name, listener)
          if (disposed) remove()
          else unlisten.push(remove)
        }
        await Promise.all([
          add('aics:gateway-ready', () => { if (!disposed) void refreshDesktopRuntime(true) }),
          add('aics:gateway-unavailable', () => {
            if (disposed) return
            refreshSequence++
            refreshPending = null
            setRuntimeOrigin(null, true)
            epochController.abort()
            epochController = new AbortController()
            configureApiTransport(desktopRuntimeFetch)
            publish({ connection: 'unavailable', bootstrap: state.bootstrap })
          }),
        ])
      }
    } catch (error) { console.warn('网关就绪通知暂不可用', error) }
    if (!disposed) await refreshDesktopRuntime()
  })()
  const stop = () => {
    if (disposed) return
    disposed = true; runtimeSetup = undefined
    // A pending host handshake belongs to this lifetime, not a later initialization.
    refreshSequence++; refreshPending = null
    clearTimeout(timer); stopVisibility(); stopRenewal()
    unlisten.splice(0).forEach(remove => remove()); epochController.abort(); listeners.clear()
  }
  runtimeSetup = { stop, ready }
  return runtimeSetup
}
