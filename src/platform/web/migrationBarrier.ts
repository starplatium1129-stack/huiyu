import type { MigrationAuthorityTarget } from './migrationAuthority.ts'
import { nextTick } from 'vue'
import { assertMaintenanceWritable, maintenanceFrozen, maintenanceParticipants } from '../maintenanceParticipants.ts'
import { abortableTask } from '../../utils/abortableTask.ts'

/** The bridge is installed before consumers mount. It is temporary upgrade code:
 * synchronous Storage writers cannot await Web Locks, so a shared marker blocks
 * them in the same native call. Remove this interception when old-profile upgrades
 * are retired; ordinary Web storage behaviour is unchanged outside maintenance. */
const BARRIER_KEY = 'huiyu:migration:barrier'
export const WRITE_LOCK = 'huiyu:migration:writes'
export const WINDOW_LOCK = 'huiyu:migration:window:'
const CHANNEL = 'huiyu:migration:v1'
let installed = false
let channel: BroadcastChannel | null = null
let ownId = ''
let stopLease: (() => void) | undefined
let busy: () => boolean = () => false
let composing = false
const INPUT_EVENTS = ['beforeinput', 'input', 'change', 'click', 'dblclick', 'pointerdown', 'mousedown', 'keydown', 'keyup', 'submit', 'paste', 'cut', 'drop', 'wheel']
interface Preparation { requestId: string; state: 'preparing' | 'ready' | 'sealed'; released: boolean; flushing: boolean; done: Promise<void> }
let preparation: Preparation | undefined
const artworkSources = new Set<() => boolean>()
export const hasPendingArtworkSource = () => [...artworkSources].some(pending => pending())
/** Only undurable media sources participate; confirmed runtime outputs already
 * have their own recovery authority. Registration outlives a closed workbench. */
export function registerMigrationArtworkSource(pending: () => boolean): () => void {
  artworkSources.add(pending)
  return () => { artworkSources.delete(pending) }
}
export function assertMigrationArtworkSourcesReady(): void {
  if (hasPendingArtworkSource()) throw new Error('仍有生成任务或未落稳的成片。请等待生成结束并入册，或下载原图后明确清除，再迁移。')
}
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
  const marker = typeof localStorage === 'undefined' ? null : localStorage.getItem(BARRIER_KEY)
  // Input is already paused. Only the existing persistence participants may
  // finish accepted drafts before the source locks are acquired and sealed.
  const flushing = preparation?.flushing && !preparation.released && preparation.state === 'preparing' && preparation.requestId === marker
  if (marker && !flushing) {
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
export interface MigrationSourceSnapshot { windowIds: string[]; sessions: Record<string, Record<string, string>> }
export interface MigrationSourceAck { type: 'ack'; requestId: string; windowId: string; session: Record<string, string>; busy: boolean; pendingArtwork: boolean; prepared: boolean }
export interface MigrationSourcePreparedAck { type: 'prepared'; requestId: string; windowId: string; ok: boolean }
function releasePreparation(requestId: string) {
  if (preparation?.requestId !== requestId) return
  const selected = preparation
  selected.released = true; selected.flushing = false
  void selected.done.finally(() => { if (preparation === selected) preparation = undefined }).catch(() => {})
}
function prepareSource(requestId: string, coordinator = false): Promise<void> {
  if (preparation && preparation.requestId !== requestId) {
    // The coordinator lease proves an old marker has no owner. Retire its
    // document-local preparation as well; a lost release message is not a lock.
    const previous = preparation
    releasePreparation(previous.requestId)
    return previous.done.then(() => prepareSource(requestId, coordinator), () => prepareSource(requestId, coordinator))
  }
  if (preparation) return preparation.requestId === requestId && !preparation.released ? preparation.done : Promise.reject(new Error('上次资料准备尚未结束，请稍后再迁移。'))
  const entry: Preparation = { requestId, state: 'preparing', released: false, flushing: false, done: Promise.resolve() }
  preparation = entry
  const current = () => {
    if (preparation !== entry || entry.released || localStorage.getItem(BARRIER_KEY) !== requestId || maintenanceFrozen()) throw new Error('资料维护身份已变化，请重新开始迁移。')
    if (composing) throw new Error('输入法仍在编辑，请完成输入后再迁移。')
  }
  entry.done = (async () => {
    current(); assertMigrationArtworkSourcesReady()
    const { flushProfileWrites, hasProfileRecoveryData } = await import('./profileStorage.ts')
    current(); entry.flushing = true
    try {
      for (let pass = 0; pass < 2; pass++) {
        await nextTick(); current()
        for (const flush of maintenanceParticipants()) { current(); await flush(coordinator ? 'migration' : undefined); current() }
      }
      await nextTick(); current(); await flushProfileWrites(); current()
      assertMigrationArtworkSourcesReady()
      if (busy() || hasProfileRecoveryData()) throw new Error('仍有进行中的操作或未保存资料，请先完成保存再迁移。')
      if (!window.dispatchEvent(new Event('beforeunload', { cancelable: true }))) throw new Error('仍有未保存编辑，迁移未开始。')
      current(); entry.state = 'ready'
    } finally { entry.flushing = false }
  })()
  void entry.done.catch(() => {})
  return entry.done
}
function sealSource(requestId: string): boolean {
  if (preparation?.requestId !== requestId || preparation.released || preparation.state !== 'ready' || composing || maintenanceFrozen()) return false
  preparation.state = 'sealed'
  return true
}
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
  // The persisted barrier also covers a window opened after preparation began.
  // Cancellation/recovery remain reachable without admitting editor events.
  const blockInput = (event: Event) => {
    const marker = localStorage.getItem(BARRIER_KEY)
    const paused = preparation && !preparation.released || marker && !marker.startsWith('{')
    // A completed unknown activation retains its write barrier, while ordinary
    // navigation must remain available to reach the existing recovery controls.
    if (!paused || event instanceof KeyboardEvent && event.key === 'Tab'
      || event.target instanceof Element && event.target.closest('button[data-migration-control]')) return
    event.preventDefault(); event.stopImmediatePropagation()
  }
  for (const event of INPUT_EVENTS) window.addEventListener(event, blockInput, { capture: true, passive: false })
  window.addEventListener('compositionstart', () => { composing = true }, true)
  window.addEventListener('compositionend', () => { composing = false }, true)
  const lease = new Promise<void>(resolve => { stopLease = resolve })
  void navigator.locks.request(WINDOW_LOCK + ownId, () => lease)
  channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = event => {
    const message = event.data as { type?: string; requestId?: string; roundId?: string }
    if (message.type === 'prepare' && message.requestId && localStorage.getItem(BARRIER_KEY) === message.requestId) {
      const requestId = message.requestId
      void prepareSource(requestId).then(() => acknowledge(true), () => acknowledge(false))
      function acknowledge(ok: boolean) { if (localStorage.getItem(BARRIER_KEY) === requestId) channel?.postMessage({ type: 'prepared', requestId, windowId: ownId, ok } satisfies MigrationSourcePreparedAck) }
    }
    if (message.type === 'release' && message.requestId) releasePreparation(message.requestId)
    if (message.type === 'reconcile' && message.roundId && recoveryRecord()?.requestId === message.requestId) {
      const marker = localStorage.getItem(BARRIER_KEY)
      void reconcileLocal().then(() => acknowledge(true), () => acknowledge(false))
      function acknowledge(ok: boolean) { if (marker === localStorage.getItem(BARRIER_KEY)) channel?.postMessage({ type: 'reconciled', requestId: message.requestId, roundId: message.roundId, windowId: ownId, ok }) }
    }
    if (message.type === 'freeze' && message.requestId && localStorage.getItem(BARRIER_KEY) === message.requestId) {
      const prepared = sealSource(message.requestId)
      channel!.postMessage({ type: 'ack', requestId: message.requestId, windowId: ownId, session: prepared ? sessionSnapshot() : {}, busy: busy(), pendingArtwork: hasPendingArtworkSource(), prepared } satisfies MigrationSourceAck)
    }
  }
  window.addEventListener('pagehide', () => { stopLease?.(); channel?.close() }, { once: true })
  return ownId
}

export async function freezeMigrationSource<T>(work: (snapshot: MigrationSourceSnapshot) => Promise<T>, signal?: AbortSignal): Promise<T> {
  initializeMigrationParticipant()
  const source = {
    windowId: ownId, channel: channel!, prepare: (requestId: string) => prepareSource(requestId, true), seal: sealSource, release: releasePreparation,
    isBusy: () => busy(), sessionSnapshot,
    mark: (requestId: string) => nativeSet!.call(localStorage, BARRIER_KEY, requestId),
    clear: (requestId: string) => { if (localStorage.getItem(BARRIER_KEY) === requestId) nativeRemove!.call(localStorage, BARRIER_KEY) },
  }
  const load = () => import('./migrationCoordinator.ts')
  const { freezeMigrationWindows } = signal ? await abortableTask(load, signal) : await load()
  signal?.throwIfAborted()
  return freezeMigrationWindows(work, source, signal)
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
