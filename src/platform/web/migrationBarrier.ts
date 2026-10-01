import type { MigrationAuthorityTarget } from './migrationAuthority.ts'
import { assertMaintenanceWritable } from '../maintenanceParticipants.ts'

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
let reconcileAuthority: ((target: MigrationAuthorityTarget) => Promise<void>) | undefined
const RECOVERY_EVENT = 'huiyu:migration-recovery'
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
export function initializeMigrationParticipant(options: { windowId?: string; isBusy?: () => boolean; reconcileAuthority?: (target: MigrationAuthorityTarget) => Promise<void> } = {}): string {
  if (options.reconcileAuthority) reconcileAuthority = options.reconcileAuthority
  if (installed) { if (options.isBusy) busy = options.isBusy; return ownId }
  if (!navigator.locks || typeof BroadcastChannel === 'undefined') throw new Error('当前环境不支持安全的跨窗口迁移。')
  ownId = options.windowId || crypto.randomUUID()
  busy = options.isBusy || busy
  installed = true
  const originalClear = Storage.prototype.clear
  Storage.prototype.setItem = function (key, value) { assertMaintenanceWritable(); assertMigrationWritable(); nativeSet!.call(this, key, value) }
  Storage.prototype.removeItem = function (key) { assertMaintenanceWritable(); assertMigrationWritable(); nativeRemove!.call(this, key) }
  Storage.prototype.clear = function () { assertMaintenanceWritable(); assertMigrationWritable(); originalClear.call(this) }
  const lease = new Promise<void>(resolve => { stopLease = resolve })
  void navigator.locks.request(WINDOW_LOCK + ownId, () => lease)
  channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = event => {
    const message = event.data as { type?: string; requestId?: string; roundId?: string }
    if (message.type === 'reconcile' && message.roundId && recoveryRecord()?.requestId === message.requestId) {
      const marker = localStorage.getItem(BARRIER_KEY)
      void reconcileLocal().then(() => acknowledge(true), () => acknowledge(false))
      function acknowledge(ok: boolean) { if (marker === localStorage.getItem(BARRIER_KEY)) channel?.postMessage({ type: 'reconciled', requestId: message.requestId, roundId: message.roundId, windowId: ownId, ok }) }
    }
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
    if (migrationRecoveryPending()) throw new Error('上次激活结果尚未确认，请先执行只读核对。')
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
    const expected = new Set([...(held.held || []), ...(held.pending || [])].map(item => item.name || '').filter(name => name.startsWith(WINDOW_LOCK)).map(name => name.slice(WINDOW_LOCK.length)))
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
        const live = [...(now.held || []), ...(now.pending || [])].map(item => item.name || '').filter(name => name.startsWith(WINDOW_LOCK)).map(name => name.slice(WINDOW_LOCK.length))
        if (live.some(id => !expected.has(id))) throw new Error('维护期间打开了新窗口，请重新盘点。')
        signal?.throwIfAborted()
        return work({ windowIds: [...expected].sort(), sessions })
      })
    } finally {
      if (localStorage.getItem(BARRIER_KEY) === requestId) nativeRemove!.call(localStorage, BARRIER_KEY)
    }
  }
}


/** A structured marker is never adopted as an abandoned ordinary export. */
export function migrationRecoveryPending(): boolean {
  const marker = localStorage.getItem(BARRIER_KEY)
  return Boolean(marker && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(marker))
}
function recoveryRecord(): { requestId: string; target: MigrationAuthorityTarget } | null {
  const raw = localStorage.getItem(BARRIER_KEY)
  if (!raw?.startsWith('{')) return null
  try {
    const value = JSON.parse(raw)
    const target = value.target
    if (value.version !== 1 || typeof value.requestId !== 'string' || !target || typeof target.migrationId !== 'string' || !/^[a-f0-9-]{36}$/.test(target.migrationId)
      || typeof target.workspaceId !== 'string' || !target.workspaceId || typeof target.sourceProfileId !== 'string' || !target.sourceProfileId
      || typeof target.sourceOrigin !== 'string' || (!Number.isSafeInteger(target.generation) || target.generation < 0)
      || !Array.isArray(target.domains) || !target.domains.includes('artwork') || target.domains.some((domain: unknown) => !['artwork', 'settings', 'chat', 'draft'].includes(String(domain)))) return null
    return value
  } catch { return null }
}
export function watchMigrationRecovery(listener: () => void): () => void {
  const storage = (event: StorageEvent) => { if (event.key === BARRIER_KEY) listener() }
  window.addEventListener('storage', storage); window.addEventListener(RECOVERY_EVENT, listener)
  return () => { window.removeEventListener('storage', storage); window.removeEventListener(RECOVERY_EVENT, listener) }
}
export function markMigrationActivation(target: MigrationAuthorityTarget): void {
  const requestId = localStorage.getItem(BARRIER_KEY)
  if (!requestId || requestId.startsWith('{')) throw new Error('迁移维护身份已变化。')
  nativeSet!.call(localStorage, BARRIER_KEY, JSON.stringify({ version: 1, requestId, target }))
  window.dispatchEvent(new Event(RECOVERY_EVENT))
}
async function reconcileLocal(): Promise<void> {
  const record = recoveryRecord()
  if (!record || !reconcileAuthority) throw new Error('激活核对尚不可用，请保持当前资料只读并联系维护人员；不要重新提交迁移。')
  await reconcileAuthority(record.target)
}
/** Caller already owns the coordinator/source locks. Success alone permits thaw. */
export async function reconcileMigrationAuthority(): Promise<void> {
  const record = recoveryRecord(), marker = localStorage.getItem(BARRIER_KEY)
  if (!record) throw new Error('激活记录无法核对，请保留备份并联系维护人员。')
  const liveWindows = async () => {
    const locks = await navigator.locks.query()
    return new Set([...(locks.held || []), ...(locks.pending || [])].map(lock => lock.name || '').filter(name => name.startsWith(WINDOW_LOCK)).map(name => name.slice(WINDOW_LOCK.length)))
  }
  const expected = await liveWindows(); expected.add(ownId)
  const roundId = crypto.randomUUID(), acknowledged = new Set<string>()
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => finish(new Error('仍有窗口未完成激活核对。资料保持只读；关闭失联窗口后可再次只读核对。')), 6000)
    function finish(error?: Error) {
      if (settled) return
      settled = true; clearTimeout(timeout); channel!.removeEventListener('message', onMessage)
      if (error) reject(error); else resolve()
    }
    function accept(windowId: string, ok: boolean) {
      if (!ok) { finish(new Error('有窗口尚未确认激活身份或资料连接。原资料保持只读；请检查桌面连接与备份，再重试核对。')); return }
      acknowledged.add(windowId)
      if (acknowledged.size === expected.size) finish()
    }
    function onMessage(event: MessageEvent<{ type: string; requestId: string; roundId: string; windowId: string; ok: boolean }>) {
      const ack = event.data
      if (ack.type === 'reconciled' && ack.requestId === record!.requestId && ack.roundId === roundId && expected.has(ack.windowId)) accept(ack.windowId, ack.ok)
    }
    channel!.addEventListener('message', onMessage)
    channel!.postMessage({ type: 'reconcile', requestId: record.requestId, roundId })
    void reconcileLocal().then(() => accept(ownId, true), error => finish(error instanceof Error ? error : new Error('激活核对失败。')))
  })
  const live = await liveWindows()
  if ([...live].some(id => !acknowledged.has(id)) || localStorage.getItem(BARRIER_KEY) !== marker) throw new Error('核对期间窗口或维护身份发生变化，请再次执行只读核对。')
  nativeRemove!.call(localStorage, BARRIER_KEY)
  window.dispatchEvent(new Event(RECOVERY_EVENT))
}
/** Explicit recovery performs reads only; never repeat activation or import. */
export async function recoverMigrationAuthority(): Promise<void> {
  initializeMigrationParticipant()
  await navigator.locks.request('huiyu:migration:coordinator', { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('迁移操作仍在完成中，请稍后再核对。')
    const signal = AbortSignal.timeout(8000)
    await navigator.locks.request('huiyu-artwork-library', { signal }, () => navigator.locks.request('aics_chat_archive_v1', { signal }, () =>
      navigator.locks.request(WRITE_LOCK, { mode: 'exclusive', signal }, reconcileMigrationAuthority)))
  })
}
