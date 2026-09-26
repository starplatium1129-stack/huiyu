/** The bridge is installed before consumers mount. It is temporary upgrade code:
 * synchronous Storage writers cannot await Web Locks, so a shared marker blocks
 * them in the same native call. Remove this interception when old-profile upgrades
 * are retired; ordinary Web storage behaviour is unchanged outside maintenance. */
const BARRIER_KEY = 'huiyu:migration:barrier'
const WRITE_LOCK = 'huiyu:migration:writes'
const WINDOW_LOCK = 'huiyu:migration:window:'
const CHANNEL = 'huiyu:migration:v1'
let installed = false
let channel: BroadcastChannel | null = null
let ownId = ''
let stopLease: (() => void) | undefined
let busy: () => boolean = () => false
let artworkReadOnly = false
const nativeSet = typeof Storage === 'undefined' ? null : Storage.prototype.setItem
const nativeRemove = typeof Storage === 'undefined' ? null : Storage.prototype.removeItem

export function retireWebArtworkWrites(): void { artworkReadOnly = true }
export function assertWebArtworkWritable(): void {
  if (artworkReadOnly) throw new Error('作品资料已由本机工作区管理，旧浏览器资料只读保留。')
}

export function assertMigrationWritable(): void {
  if (typeof localStorage !== 'undefined' && localStorage.getItem(BARRIER_KEY)) {
    throw new Error('数据迁移维护中，请等待完成后再保存。')
  }
}
export async function withMigrationWrite<T>(work: () => Promise<T>): Promise<T> {
  assertMigrationWritable()
  const action = () => { assertMigrationWritable(); return work() }
  return globalThis.navigator?.locks ? navigator.locks.request(WRITE_LOCK, { mode: 'shared' }, action) : action()
}
function sessionSnapshot(): Record<string, string> {
  return Object.fromEntries(Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i))
    .filter((key): key is string => key !== null).map(key => [key, sessionStorage.getItem(key)!]))
}
interface Ack { type: 'ack'; requestId: string; windowId: string; session: Record<string, string>; busy: boolean }
export function initializeMigrationParticipant(options: { windowId?: string; isBusy?: () => boolean } = {}): string {
  if (installed) { if (options.isBusy) busy = options.isBusy; return ownId }
  if (!navigator.locks || typeof BroadcastChannel === 'undefined') throw new Error('当前环境不支持安全的跨窗口迁移。')
  ownId = options.windowId || crypto.randomUUID()
  busy = options.isBusy || busy
  installed = true
  const originalClear = Storage.prototype.clear
  Storage.prototype.setItem = function (key, value) { assertMigrationWritable(); nativeSet!.call(this, key, value) }
  Storage.prototype.removeItem = function (key) { assertMigrationWritable(); nativeRemove!.call(this, key) }
  Storage.prototype.clear = function () { assertMigrationWritable(); originalClear.call(this) }
  const lease = new Promise<void>(resolve => { stopLease = resolve })
  void navigator.locks.request(WINDOW_LOCK + ownId, () => lease)
  channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = event => {
    const message = event.data as { type?: string; requestId?: string }
    if (message.type === 'freeze' && message.requestId && localStorage.getItem(BARRIER_KEY) === message.requestId) {
      channel!.postMessage({ type: 'ack', requestId: message.requestId, windowId: ownId, session: sessionSnapshot(), busy: busy() } satisfies Ack)
    }
  }
  window.addEventListener('pagehide', () => { stopLease?.(); channel?.close() }, { once: true })
  return ownId
}

export async function freezeMigrationSource<T>(work: (snapshot: { windowIds: string[]; sessions: Record<string, Record<string, string>> }) => Promise<T>, signal?: AbortSignal): Promise<T> {
  initializeMigrationParticipant()
  return navigator.locks.request('huiyu:migration:coordinator', { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('另一窗口正在迁移。')
    // Match the existing backup lock order. An accepted library/archive change
    // reaches its durable boundary before synchronous browser writes are frozen.
    return navigator.locks.request('huiyu-artwork-library', { signal }, () =>
      navigator.locks.request('aics_chat_archive_v1', { signal }, () => freeze()))
  })
  async function freeze(): Promise<T> {
    // Acquiring the exclusive coordinator lock proves the old browser document
    // no longer owns maintenance. Adopt a crash-left marker while writes stay
    // blocked; never infer liveness from a timestamp or release it before checks.
    const requestId = crypto.randomUUID()
    const held = await navigator.locks.query()
    const expected = new Set((held.held || []).map(item => item.name || '').filter(name => name.startsWith(WINDOW_LOCK)).map(name => name.slice(WINDOW_LOCK.length)))
    expected.add(ownId)
    nativeSet!.call(localStorage, BARRIER_KEY, requestId)
    try {
      return await navigator.locks.request(WRITE_LOCK, { mode: 'exclusive', signal }, async () => {
        if (busy()) throw new Error('仍有生成或保存任务，请待任务安全结束后再迁移。')
        const sessions: Record<string, Record<string, string>> = { [ownId]: sessionSnapshot() }
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => finish(new Error('有窗口未确认维护，迁移未开始。')), 5000)
          const abort = () => finish(signal?.reason || new Error('迁移已取消。'))
          const onMessage = (event: MessageEvent<Ack>) => {
            const ack = event.data
            if (ack.type !== 'ack' || ack.requestId !== requestId || !expected.has(ack.windowId)) return
            if (ack.busy) { finish(new Error('其他窗口仍有进行中的任务。')); return }
            sessions[ack.windowId] = ack.session
            if (Object.keys(sessions).length === expected.size) finish()
          }
          function finish(error?: unknown) {
            clearTimeout(timeout); channel!.removeEventListener('message', onMessage); signal?.removeEventListener('abort', abort)
            if (error) reject(error); else resolve()
          }
          channel!.addEventListener('message', onMessage)
          signal?.addEventListener('abort', abort, { once: true })
          channel!.postMessage({ type: 'freeze', requestId })
          if (expected.size === 1) finish()
        })
        const now = await navigator.locks.query()
        const live = (now.held || []).map(item => item.name || '').filter(name => name.startsWith(WINDOW_LOCK)).map(name => name.slice(WINDOW_LOCK.length))
        if (live.some(id => !expected.has(id))) throw new Error('维护期间打开了新窗口，请重新盘点。')
        signal?.throwIfAborted()
        return work({ windowIds: [...expected].sort(), sessions })
      })
    } finally {
      if (localStorage.getItem(BARRIER_KEY) === requestId) nativeRemove!.call(localStorage, BARRIER_KEY)
    }
  }
}
