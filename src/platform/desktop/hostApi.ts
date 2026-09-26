interface DesktopHostApi {
  readonly nativeDragRegions?: true
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> }
  event: { listen<T>(name: string, listener: (event: { payload: T }) => void): Promise<() => void> }
  window: { getCurrentWindow(): { startDragging(): Promise<void> } }
}
interface ElectronHostApi {
  commands: Record<string, ((args?: Record<string, unknown>) => Promise<unknown>) | undefined>
  event: DesktopHostApi['event']
  startDragging(): Promise<void>
}
export function hostApi(): DesktopHostApi | undefined {
  if (typeof window === 'undefined') return undefined
  const hosts = window as Window & { __TAURI__?: DesktopHostApi; __HUIYU_ELECTRON__?: ElectronHostApi }
  if (hosts.__TAURI__) return hosts.__TAURI__
  const electron = hosts.__HUIYU_ELECTRON__
  if (!electron) return undefined
  // Electron exposes only individually registered preload commands. This
  // normalization stays inside the platform adapter; there is no Tauri shim.
  return {
    nativeDragRegions: true,
    core: { async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      const method = electron.commands[command]
      if (!method) throw new Error('桌面能力未实现：' + command)
      return await method(args) as T
    } },
    event: electron.event,
    window: { getCurrentWindow: () => ({ startDragging: () => electron.startDragging() }) },
  }
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
