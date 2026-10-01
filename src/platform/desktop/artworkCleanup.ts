import { nextTick } from 'vue'
import { installArtworkCleanupCoordinator, startArtworkSession, stopArtworkSession } from '../../storage/artworkSession'
import { collectImageReferences, readSessionImageReferences } from '../../utils/storageReferences'
import { maintenanceFrozen, maintenanceParticipants, setArtworkCleanupPhase } from '../maintenanceParticipants'
import { flushProfileWrites, hasPendingProfileWrites, hasProfileRecoveryData, profileDraftStorage } from '../web/profileStorage'
import { assertMigrationWritable } from '../web/migrationBarrier'
import { getDesktopRuntime, onDesktopRuntime } from './runtime'

const CHANNEL = 'huiyu:desktop-artwork-cleanup:v1'
const REGISTRY = 'huiyu:desktop-artwork-document:'
const COORDINATOR = 'huiyu:desktop-artwork-cleanup'
const INPUT_EVENTS = ['beforeinput', 'input', 'change', 'click', 'dblclick', 'pointerdown', 'mousedown', 'keydown', 'keyup', 'submit', 'paste', 'cut', 'drop', 'wheel']
type Message = { type: 'pause' | 'ack' | 'resume'; requestId: string; scope: string; participant?: string; references?: string[]; error?: string; deadlineAt?: number }
type Paused = { request: Message; timer: ReturnType<typeof setTimeout>; stopping?: Promise<void>; restoring?: Promise<void> }
const busyMessage = '其他绘遇窗口仍有未保存编辑或进行中的操作，请先完成保存再清理；本次未删除图片'
function identity() {
  const state = getDesktopRuntime(), bootstrap = state.bootstrap
  if (state.connection !== 'ready' || !bootstrap?.runtime || bootstrap.runtime.workspace?.domains.includes('artwork')) return null
  const scope = [bootstrap.sourceProfileId, bootstrap.sourceOrigin, bootstrap.runtime.runtimeEpoch].map(encodeURIComponent).join(':')
  return { scope, role: bootstrap.windowRole }
}

/** Legacy desktop origins still share IndexedDB with the host's hidden
 * companion documents. Pause only verified sibling roles, then retain the
 * original exclusive lock: foreign documents and in-flight staging still veto. */
export async function installDesktopArtworkCleanup(options: { isBusy: () => boolean; waitForSync?: () => Promise<unknown> }): Promise<() => void> {
  const selected = identity(), locks = navigator.locks
  if (!selected || !locks || typeof BroadcastChannel === 'undefined') return () => {}
  const channel = new BroadcastChannel(CHANNEL)
  const participant = `${REGISTRY}${selected.scope}:${selected.role}:${crypto.randomUUID()}`
  let releaseRegistry!: () => void, enterRegistry!: () => void, failRegistry!: (error: unknown) => void
  const registered = new Promise<void>((resolve, reject) => { enterRegistry = resolve; failRegistry = reject })
  const registryLease = new Promise<void>(resolve => { releaseRegistry = resolve })
  const registry = locks.request(participant, async () => { enterRegistry(); await registryLease })
  void registry.catch(failRegistry)
  let paused: Paused | undefined, disposed = false, composing = false
  let cancelCleanup: (() => void) | undefined
  let activeRequest: string | undefined
  const blockInput = (event: Event) => { if (paused || activeRequest) { event.preventDefault(); event.stopImmediatePropagation() } }
  const compositionStart = () => { composing = true }, compositionEnd = () => { composing = false }
  function check() {
    const current = identity()
    if (current?.scope !== selected!.scope || current.role !== selected!.role || disposed) throw new Error('桌面连接已变化，请重新读取后清理')
  }
  function guard() {
    check(); assertMigrationWritable()
    if (composing || options.isBusy() || hasProfileRecoveryData() || !document.getElementById('app')?.childElementCount) throw new Error(busyMessage)
    for (const dialog of document.querySelectorAll('dialog[open], [role="dialog"]:not([aria-hidden="true"])')) {
      if (dialog.getClientRects().length && dialog.querySelector('input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), [contenteditable="true"]')) throw new Error(busyMessage)
    }
  }
  async function flushWindow(activeGuard: () => void) {
    activeGuard(); await options.waitForSync?.()
    for (let pass = 0; pass < 2; pass++) {
      await nextTick(); activeGuard()
      for (const flush of maintenanceParticipants()) { activeGuard(); await flush() }
    }
    await nextTick(); activeGuard(); await flushProfileWrites(); activeGuard()
    if (hasPendingProfileWrites() || !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))) throw new Error(busyMessage)
  }
  async function resume(entry: Paused) {
    if (paused !== entry) return
    if (entry.restoring) return entry.restoring
    clearTimeout(entry.timer)
    // Rejoin before allowing input. If the requester already holds exclusive
    // cleanup access, even a timeout cannot reopen writes until it releases it.
    entry.restoring = (async () => {
      await entry.stopping
      if (!disposed) await startArtworkSession()
      if (paused === entry) { paused = undefined; setArtworkCleanupPhase('idle') }
    })()
    return entry.restoring
  }
  async function pause(request: Message) {
    if (selected!.role === 'atelier') return
    if (paused || maintenanceFrozen()) {
      channel.postMessage({ type: 'ack', requestId: request.requestId, scope: selected!.scope, participant, error: busyMessage } satisfies Message)
      return
    }
    if (!Number.isSafeInteger(request.deadlineAt) || request.deadlineAt! <= Date.now() || request.deadlineAt! > Date.now() + 10_000) return
    const entry: Paused = { request, timer: setTimeout(() => { void resume(entry).catch(() => {}) }, request.deadlineAt! - Date.now()) }
    paused = entry; setArtworkCleanupPhase('preparing')
    const activeGuard = () => {
      if (paused !== entry || entry.restoring) throw new Error(busyMessage)
      guard()
    }
    try {
      await flushWindow(activeGuard)
      const references = [...collectImageReferences(readSessionImageReferences(profileDraftStorage))]
      setArtworkCleanupPhase('sealed')
      entry.stopping = stopArtworkSession()
      await entry.stopping
      if (paused !== entry || entry.restoring) return
      channel.postMessage({ type: 'ack', requestId: request.requestId, scope: selected!.scope, participant, references } satisfies Message)
    } catch {
      if (!disposed) channel.postMessage({ type: 'ack', requestId: request.requestId, scope: selected!.scope, participant, error: busyMessage } satisfies Message)
      await resume(entry)
    }
  }
  channel.addEventListener('message', event => {
    const message = event.data as Message
    if (!message || message.scope !== selected!.scope || typeof message.requestId !== 'string' || !/^[\w-]{36}$/.test(message.requestId)) return
    if (message.type === 'pause') void pause(message).catch(() => {})
    else if (message.type === 'resume' && paused?.request.requestId === message.requestId) void resume(paused).catch(() => {})
  })
  const removeCoordinator = selected.role === 'atelier' ? installArtworkCleanupCoordinator(async (work, signal) => {
    check(); signal?.throwIfAborted()
    if (maintenanceFrozen()) throw new Error(busyMessage)
    return locks.request(COORDINATOR, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error(busyMessage)
      setArtworkCleanupPhase('preparing')
      const requestId = crypto.randomUUID(), epoch = new AbortController()
      activeRequest = requestId
      cancelCleanup = () => epoch.abort(new Error('已取消清理'))
      const combined = signal ? AbortSignal.any([signal, epoch.signal]) : epoch.signal
      const removeRuntime = onDesktopRuntime(() => { if (identity()?.scope !== selected.scope) epoch.abort(new Error('桌面连接已变化，请重新读取后清理')) })
      const references = new Set<string>()
      try {
        const held = await locks.query(), prefix = REGISTRY + selected.scope + ':'
        const expected = new Set((held.held ?? []).map(info => info.name ?? '').filter(name => name.startsWith(prefix)
          && /^(companion|companion-chat):[\w-]{36}$/.test(name.slice(prefix.length))))
        if (expected.size) await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error(busyMessage)), 5000)
            const abort = () => finish(combined.reason)
            function finish(error?: unknown) {
              clearTimeout(timer); channel.removeEventListener('message', onAck); combined.removeEventListener('abort', abort)
              if (error) reject(error); else resolve()
            }
            const onAck = (event: MessageEvent<Message>) => {
              const ack = event.data
              if (ack?.type !== 'ack' || ack.requestId !== requestId || ack.scope !== selected.scope || !expected.has(ack.participant ?? '')) return
              if (ack.error || !Array.isArray(ack.references) || ack.references.some(value => typeof value !== 'string')) { finish(new Error(busyMessage)); return }
              ack.references.forEach(value => references.add(value)); expected.delete(ack.participant!)
              if (!expected.size) finish()
            }
            channel.addEventListener('message', onAck); combined.addEventListener('abort', abort, { once: true })
            if (combined.aborted) { abort(); return }
            channel.postMessage({ type: 'pause', requestId, scope: selected.scope, deadlineAt: Date.now() + 5000 } satisfies Message)
          })
        await flushWindow(() => { check(); combined.throwIfAborted(); guard() })
        setArtworkCleanupPhase('sealed')
        return await work([...references], combined)
      } finally {
        removeRuntime(); cancelCleanup = undefined; activeRequest = undefined; setArtworkCleanupPhase('idle')
        if (!disposed) channel.postMessage({ type: 'resume', requestId, scope: selected.scope } satisfies Message)
      }
    })
  }) : () => {}
  const removeRuntime = onDesktopRuntime(() => { if (paused && identity()?.scope !== selected.scope) void resume(paused).catch(() => {}) })
  for (const event of INPUT_EVENTS) window.addEventListener(event, blockInput, { capture: true, passive: false })
  window.addEventListener('compositionstart', compositionStart, true); window.addEventListener('compositionend', compositionEnd, true)
  function stop() {
    if (activeRequest) channel.postMessage({ type: 'resume', requestId: activeRequest, scope: selected!.scope } satisfies Message)
    disposed = true; cancelCleanup?.(); removeCoordinator(); removeRuntime(); releaseRegistry()
    if (paused) void resume(paused).catch(() => {})
    for (const event of INPUT_EVENTS) window.removeEventListener(event, blockInput, true)
    window.removeEventListener('compositionstart', compositionStart, true); window.removeEventListener('compositionend', compositionEnd, true)
    void registry.catch(() => {}); channel.close()
  }
  try { await registered } catch (error) { stop(); throw error }
  return stop
}
