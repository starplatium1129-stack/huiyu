interface TauriApi {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> }
  event: { listen<T>(name: string, listener: (event: { payload: T }) => void): Promise<() => void> }
  window: { getCurrentWindow(): { startDragging(): Promise<void> } }
}
export function hostApi(): TauriApi | undefined {
  return typeof window === 'undefined' ? undefined : (window as Window & { __TAURI__?: TauriApi }).__TAURI__
}
// Kept private to desktop adapters; application consumers import named capabilities.
export function invokeHost<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const host = hostApi()
  return host ? (args === undefined ? host.core.invoke<T>(command) : host.core.invoke<T>(command, args)) : Promise.reject(new Error('桌面能力不可用'))
}
let nextId = 0
const subscriptions = new Map<number, { cancelled: boolean; remove?: () => void }>()
export function onHostEvent<T>(name: string, listener: (payload: T) => void): number {
  const id = ++nextId
  const entry: { cancelled: boolean; remove?: () => void } = { cancelled: false }
  subscriptions.set(id, entry)
  void hostApi()?.event.listen<T>(name, event => { if (!entry.cancelled) listener(event.payload) }).then(remove => {
    if (entry.cancelled) remove(); else entry.remove = remove
  }).catch(() => subscriptions.delete(id))
  return id
}
export function offHostEvent(id: number): void {
  const entry = subscriptions.get(id)
  if (entry) { entry.cancelled = true; entry.remove?.(); subscriptions.delete(id) }
}
export function hasHostEvent(id: number): boolean { return subscriptions.has(id) }
