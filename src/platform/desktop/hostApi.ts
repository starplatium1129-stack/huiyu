interface DesktopHostApi {
  core: { invoke<T>(command: string, args?: Record<string, unknown> | Uint8Array, options?: { headers?: HeadersInit }): Promise<T> }
  event: {
    listen<T>(name: string, listener: (event: { payload: T }) => void, options?: { target: string }): Promise<() => void>
    emit<T>(name: string, payload: T): Promise<void>
  }
  window: { getCurrentWindow(): { label: string; startDragging(): Promise<void> } }
}
export function hostApi(): DesktopHostApi | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as Window & { __TAURI__?: DesktopHostApi }).__TAURI__
}
// Kept private to desktop adapters; application consumers import named capabilities.
export function invokeHost<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const host = hostApi()
  return host ? (args === undefined ? host.core.invoke<T>(command) : host.core.invoke<T>(command, args)) : Promise.reject(new Error('桌面能力不可用'))
}
let nextId = 0
const subscriptions = new Map<number, { cancelled: boolean; remove?: () => void }>()
export function onHostEvent<T>(name: string, listener: (payload: T) => void, scope?: 'current-window'): number {
  const id = ++nextId
  const entry: { cancelled: boolean; remove?: () => void } = { cancelled: false }
  subscriptions.set(id, entry)
  const host = hostApi()
  const options = host && scope === 'current-window' ? { target: host.window.getCurrentWindow().label } : undefined
  void host?.event.listen<T>(name, event => { if (!entry.cancelled) listener(event.payload) }, options).then(remove => {
    if (entry.cancelled) remove(); else entry.remove = remove
  }).catch(() => subscriptions.delete(id))
  return id
}
export function offHostEvent(id: number): void {
  const entry = subscriptions.get(id)
  if (entry) { entry.cancelled = true; entry.remove?.(); subscriptions.delete(id) }
}
