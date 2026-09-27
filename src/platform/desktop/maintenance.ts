import { nextTick } from 'vue'
import { invokeHost, onHostEvent, offHostEvent } from './hostApi'
import { flushProfileWrites, hasPendingProfileWrites, hasProfileRecoveryData } from '../web/profileStorage'
import { maintenanceParticipants, setMaintenancePhase } from '../maintenanceParticipants'
import { assertMigrationWritable } from '../web/migrationBarrier'

interface Preparation { requestId: string; deadlineAt: number }
interface Result { requestId: string; state: 'cancelled' | 'blocked'; reason?: string }
interface Acknowledgement { requestId: string; ok: boolean; error?: string }
interface Active { request: Preparation; ack?: Acknowledgement; blocked: boolean }
const INPUT_EVENTS = ['beforeinput', 'input', 'change', 'click', 'dblclick', 'pointerdown', 'mousedown', 'keydown', 'keyup', 'submit', 'paste', 'cut', 'drop', 'wheel']
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)

/** Desktop-only controller, loaded after host bootstrap; ordinary Web does not install it. */
export function installDesktopMaintenance(options: { isBusy: () => boolean; waitForSync?: () => Promise<unknown> }): () => void {
  let active: Active | undefined, notice: HTMLElement | undefined, composing = false
  const blockInput = (event: Event) => { if (active) { event.preventDefault(); event.stopImmediatePropagation() } }
  const compositionStart = () => { composing = true }
  const compositionEnd = () => { composing = false }
  function message(text: string) {
    if (!notice) {
      notice = document.createElement('aside')
      notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite')
      notice.dataset.desktopMaintenance = 'true'
      notice.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-content:center;padding:24px;background:var(--bg-surface,#fff);color:var(--text-primary,#14121c);font:inherit;text-align:center;'
      document.body.append(notice)
    }
    notice.textContent = text
  }
  function thaw() { active = undefined; setMaintenancePhase('idle'); notice?.remove(); notice = undefined }
  function guard() {
    if (composing) throw new Error('INPUT_COMPOSING')
    if (options.isBusy()) throw new Error('WINDOW_BUSY')
    try { assertMigrationWritable() } catch { throw new Error('MIGRATION_BUSY') }
    if (!document.getElementById('app')?.childElementCount) throw new Error('WINDOW_NOT_READY')
    if (hasProfileRecoveryData()) throw new Error('UNSAVED_RECOVERY')
    // Feature participants own dirty state. This additional guard keeps an
    // unfamiliar open editor from being implicitly submitted or discarded.
    for (const dialog of document.querySelectorAll('dialog[open], [role="dialog"]:not([aria-hidden="true"])')) {
      if (dialog.getClientRects().length && dialog.querySelector('input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), [contenteditable="true"]')) throw new Error('OPEN_EDITOR')
    }
  }
  async function acknowledge(entry: Active, value: Acknowledgement) {
    if (active !== entry || entry.blocked) return
    entry.ack ||= value
    try { await invokeHost('desktop_maintenance_ack', { ...entry.ack }) }
    catch { if (active === entry) message('维护确认未送达，正在等待宿主取消；当前编辑仍保留。') }
  }
  async function prepare(entry: Active) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (entry.request.deadlineAt <= Date.now()) throw new Error('FLUSH_TIMEOUT')
      await Promise.race([
        (async () => {
          guard()
          await options.waitForSync?.()
          // Vue's queued watches must schedule their persistence work before the
          // participants flush. The second turn catches archive/restore watchers.
          for (let pass = 0; pass < 2; pass++) {
            await nextTick(); guard()
            if (active !== entry || entry.blocked) throw new Error('MAINTENANCE_CANCELLED')
            for (const flush of maintenanceParticipants()) {
              if (active !== entry || entry.blocked) throw new Error('MAINTENANCE_CANCELLED')
              await flush()
            }
          }
          await nextTick(); await flushProfileWrites(); guard()
          if (hasPendingProfileWrites()) throw new Error('PERSISTENCE_PENDING')
          const beforeUnload = new Event('beforeunload', { cancelable: true })
          if (!window.dispatchEvent(beforeUnload)) throw new Error('UNSAVED_EDITOR')
          if (active !== entry || entry.blocked) throw new Error('MAINTENANCE_CANCELLED')
          setMaintenancePhase('sealed')
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('FLUSH_TIMEOUT')), Math.max(0, entry.request.deadlineAt - Date.now())) }),
      ])
      message('资料已保存，正在等待桌面维护完成。')
      await acknowledge(entry, { requestId: entry.request.requestId, ok: true })
    } catch (error) {
      if (active !== entry || entry.blocked) return
      const code = error instanceof Error && /^[A-Z_]{1,48}$/.test(error.message) ? error.message : 'SAVE_FAILED'
      message('仍有未保存编辑或进行中的操作，维护未获确认，正在等待取消。')
      await acknowledge(entry, { requestId: entry.request.requestId, ok: false, error: code })
    } finally { clearTimeout(timer) }
  }
  const preparation = onHostEvent<Preparation>('aics:maintenance-prepare', request => {
    if (!request || !validId(request.requestId) || !Number.isSafeInteger(request.deadlineAt)) return
    if (active) {
      if (active.request.requestId === request.requestId && active.ack) void acknowledge(active, active.ack)
      return
    }
    active = { request, blocked: false }; setMaintenancePhase('preparing')
    message('正在保存当前编辑，请稍候…')
    void prepare(active)
  })
  const result = onHostEvent<Result>('aics:maintenance-result', response => {
    if (!active || response?.requestId !== active.request.requestId) return
    if (response.state === 'cancelled' && !active.blocked) thaw()
    else if (response.state === 'blocked') {
      active.blocked = true; setMaintenancePhase('sealed')
      message('维护尚未完成，编辑已暂停。可从托盘选择“退出 Companion”正常退出后重启并检查维护结果；确认前请勿继续安装。')
    }
  })
  for (const event of INPUT_EVENTS) window.addEventListener(event, blockInput, { capture: true, passive: false })
  window.addEventListener('compositionstart', compositionStart, true)
  window.addEventListener('compositionend', compositionEnd, true)
  return () => {
    offHostEvent(preparation); offHostEvent(result)
    for (const event of INPUT_EVENTS) window.removeEventListener(event, blockInput, true)
    window.removeEventListener('compositionstart', compositionStart, true); window.removeEventListener('compositionend', compositionEnd, true)
    thaw()
  }
}
